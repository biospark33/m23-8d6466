# blind-tests-contract

## [MEDIUM] The password-half leak test's log assertion is the one unguarded absence claim in the file
- **File:line:** `tests/providers/exedev/image-contract.test.ts:951`
- **Trigger:** `JSON.stringify([])` is `"[]"`, which contains no canary. If a regression makes `create()` emit **nothing** on the reject path (the sink never installed, the event dropped, the throw moved above the emit), this assertion passes vacuously and the test still goes green on its remaining three assertions — all of which are about `err.message`, not about logs. Every sibling leak test guards this: line 841 asserts `lines.length > 0` before the same check; lines 927-928 and 987-989 assert on a `create_failed` line found in `lines` before/around the same check. This one has no `lines` assertion of any kind other than the stringified-absence one, so the "no credential in any emitted line" claim here is only as strong as the assumption that lines were emitted at all.
- **Evidence:**
```
      expect(JSON.stringify(lines).includes(CANARY_SECRET)).toBe(false);
    } finally {
      fake.cleanup();
```
  (test `"stderr echoing ONLY the password half is redacted too"`, file lines 940-957 — no `expect(lines.length)`, no `lines.find(...)`)

## [MEDIUM] Redaction is asserted only as "secret absent + marker present" — total obliteration of stderr passes all three tests
- **File:line:** `tests/providers/exedev/image-contract.test.ts:916`, `:950`, `:978`
- **Trigger:** All three scrub tests assert exactly two things about the message: it does not contain the secret, and it contains `[registry-auth redacted]`. An implementation that, whenever `registryAuth` is configured, replaces the **entire** substrate stderr with the literal `[registry-auth redacted]` satisfies every one of them while destroying the operator's diagnostic. The leaky fixture at line 902 deliberately builds a stderr with real signal in it (`exe.dev: unknown flag in: new --image <ref> ... --json`) and nothing asserts any of that signal survives — not the `unknown flag` text, not `PINNED`, which is a *public* pin the file argues at line 274-278 must be echoed. There is also no test that the redaction does **not** fire when no credential is configured (the `df210-auth-off` test at 872-890 checks argv and `registryAuthUsed`, never an error path), so an over-broad scrub applied unconditionally is invisible to this suite too. Cannot confirm the production scrub's granularity without reading `driver.ts` — capped at MEDIUM.
- **Evidence:**
```
      expect(err.message.includes(CANARY_SECRET)).toBe(false);
      expect(err.message).toContain("[registry-auth redacted]");
```
  (identical pair at 915-916, 949-950, 977-978; no assertion that any non-secret stderr content is preserved)

## [MEDIUM] The "not a cent was spent" claim is an unguarded absence over a filtered array
- **File:line:** `tests/providers/exedev/image-contract.test.ts:1296-1299`
- **Trigger:** `boxCmds` is built by filtering `fake.calls` on `a[1] === "<runId>.exe.xyz"` and projecting `a[2]`. If that argv shape ever drifts (host moves index, ssh gains a `-o` flag before the host, the command lands at `a[3]`), `boxCmds` becomes `[]` and `.some(...)` is `false` — the assertion passes while proving nothing. This is the test's entire load-bearing claim (gate B refused *before* paid model traffic). The sibling that uses the identical filter at 1158-1161 makes a **positive** claim (`.some(...)).toBe(true)`), so it self-guards against exactly this drift; this one does not, and there is no `expect(boxCmds.length).toBeGreaterThan(0)` before it.
- **Evidence:**
```
      const boxCmds = fake.calls
        .filter((a) => a[1] === "df210-marker-perfect.exe.xyz")
        .flatMap((a) => (typeof a[2] === "string" ? [a[2]] : []));
      expect(boxCmds.some((c) => c.includes("chat/completions"))).toBe(false);
```

## [MEDIUM] INV-IBOX-2 (both-or-neither pin) is asserted only at the factory; the direct constructor is not just untested, it is baked in as legal
- **File:line:** `tests/providers/exedev/image-contract.test.ts:426` (the guard) vs `:285`, `:309`, `:351`, `:809`, `:875` (the half-pins the suite relies on)
- **Trigger:** Line 426 asserts `exeDevDriverFromEnv({}, { run, image: PINNED })` refuses with `image-pin-incomplete` — "a caller SPLITTING the pair through opts alone is exactly the half-pin the guard exists to stop". But roughly a dozen tests construct `new ExeDevDriver({ run, image: PINNED })` with no `imageBuildId` and assert **success**, and line 852 then asserts the resulting driver logs `imageBuildId === DEFAULT_IMAGE_BUILD_ID` while booting `--image PINNED`. That is precisely the split pin, taken through the other entry point, with no test claiming it is either refused or intentionally allowed. On a real box that driver boots one image and verifies gate B against a different build's id — a guaranteed fleet-wide gate-B refusal, which is the failure mode the comment at 390-393 says the guard exists to prevent. The fake hides it because `fake.configure` sets the box's marker independently of the `--image` argv, so no test in the file can notice. Cannot confirm whether the constructor deliberately omits the check without reading `driver.ts` — capped at MEDIUM.
- **Evidence:**
```
      expect(
        refusal(() => exeDevDriverFromEnv({}, { run: fake.run, image: PINNED }), "opts image without buildId").code,
      ).toBe("image-pin-incomplete");
```
  vs.
```
      const driver = new ExeDevDriver({ run: fake.run, image: PINNED, registryAuth: VALID_AUTH, postureFile: ratified });
```

## [MEDIUM] The exit-code taxonomy is only half-built: the `cat` leg is never tested for a transport exit
- **File:line:** `tests/providers/exedev/image-contract.test.ts:1248-1266`
- **Trigger:** The D1/D2 test builds a careful classification matrix for the **probe** leg — exit 1 → `image-marker-mismatch` ("did not boot a factory image"), exit 143 → `image-marker-unreachable`, exit 255 → `image-marker-unreachable` — and asserts each. For the **read** leg it tests only `imageMarkerCatExit: 137` (unreachable) and, in the other table at line 1178, `imageMarkerCatExit: 1` (mismatch, "could not be read (exit 1)"). `imageMarkerCatExit: 255` — the ssh connection dropping between the successful `test -f` and the `cat`, the single most likely real transport fault on that leg — is untested in both directions. If production classifies a cat-255 as `image-marker-mismatch`, an operator gets "could not be read" under an image finding and audits the pin for a network blip, which is the exact miscategorisation this test exists to prevent, on the exact leg it did not cover. `imageMarkerCatExit: 143` is likewise absent.
- **Evidence:**
```
      { id: "df210-marker-ssh255", box: { imageMarkerProbeExit: 255 }, why: /exit 255 — ssh connection failed or dropped mid-flight/ },
      // The probe answered, the read was SIGKILLed at the budget.
      { id: "df210-marker-kill137", box: { imageMarkerProbeExit: 0, imageMarkerCatExit: 137 }, why: /exit 137 — SIGKILLed at the exec budget/ },
```

## [LOW] `expect(fake.calls).toEqual([])` after constructor-only refusals is a dead assertion, and its rationale comment is wrong
- **File:line:** `tests/providers/exedev/image-contract.test.ts:230-231` (also `:267`, `:428`, `:588`, `:720`, `:769`)
- **Trigger:** These tests only ever call `new ExeDevDriver(...)` / `exeDevDriverFromEnv(...)` — `create()` is never invoked — so `local.calls` is empty for *every* implementation, including one that validates nowhere at all. The comment at 197-202 claims the empty call log "is what proves nothing reached the wire" and that `expect(...).toThrow()` alone "would also pass on an implementation that validated inside create() after issuing the command". That is backwards: `refusal(() => new ExeDevDriver(...))` throwing at construction *is* the constructor-timing proof, and an implementation that validated inside `create()` would make the `toBeInstanceOf` fail, not the calls check. The assertion is dead weight defended by an incorrect rationale, which is worse than no assertion — a future reader will trust the timing claim to the wrong line.
- **Evidence:**
```
      // Not one command was built, for any of them.
      expect(local.calls).toEqual([]);
      expect(local.creates).toEqual([]);
```

## [LOW] Tautological assertion on a literal the test itself constructed
- **File:line:** `tests/providers/exedev/image-contract.test.ts:1006`
- **Trigger:** `EVERY_ASSERTION_ITEM` is a test-authored object literal on line 1002 with keys `A`–`E`; asserting its own `Object.keys()` equals `["A","B","C","D","E"]` cannot fail unless someone edits line 1002. The comment claims the compile-time half (`Record<AssertionItem, true>` erroring under a sixth letter) carries it, but `bun test` does not typecheck — the runtime claim only holds if a separate `bunx tsc` gate runs, which this file cannot enforce. The line below it (`Object.keys(ASSERTION_CODE)`) is the assertion that actually reads production state and does the work.
- **Evidence:**
```
    expect(Object.keys(EVERY_ASSERTION_ITEM).sort()).toEqual(["A", "B", "C", "D", "E"]);
```

## [LOW] Canary leak assertions are constant-true on 13 of the 15 ratification arms
- **File:line:** `tests/providers/exedev/image-contract.test.ts:686-687`
- **Trigger:** `CANARY_SECRET` is present in only two of the fifteen `refused` inputs — the malformed-JSON file's bytes (line 607) and the `scope-alongside` token list (line 625). For the other thirteen (`plain`, `null`, `array`, `scope`, `scope-type`, `no-expiry`, `bad-expiry`, `tz-less-expiry`, `non-iso-expiry`, `lapsed`, `blank-owner`, `no-owner`, and the nonexistent-path arm) the canary is nowhere in the input universe, so no implementation could ever put it in the output and both assertions are constant-true. Cost is noise rather than false confidence — the two live arms do real work — but a reader counting green assertions will over-credit the scrub coverage by 13×.
- **Evidence:**
```
      expect(err.message.includes(CANARY_SECRET), why).toBe(false);
      expect(err.remediation.includes(CANARY_SECRET), why).toBe(false);
```

## [LOW] The 0600 fixture's mode is not pinned by `chmod`, in the one test whose subject is file mode
- **File:line:** `tests/providers/exedev/image-contract.test.ts:757`
- **Trigger:** Lines 735-739 add an explicit `chmodSync(loose, 0o644)` with a comment stating that `writeFileSync`'s `mode` is masked by the process umask and "chmod is what actually pins the mode". The `tight` fixture eighteen lines later relies on `writeFileSync(..., { mode: 0o600 })` alone. umask can only *clear* bits, so under an exotic umask (0177, 0277) the file is born 0400/0200 rather than 0600; if the driver's check is an equality on `mode & 0o777` rather than a "no group/other bits" mask, the `not.toThrow()` acceptance and the follow-on unratified assertion both flake red on a correct driver — in the single test whose entire subject is file permissions.
- **Evidence:**
```
      const tight = join(authDir, "auth-0600");
      writeFileSync(tight, `${VALID_AUTH}\n`, { mode: 0o600 });
```
