# Edge Case Review: CLI chunk (pr128-r6)

## Arg edge: `fleet fanout`

- **No pattern**: scripts/fleet.ts:1595-1596 - `unknown pattern: undefined` — HANDLED (refusal at line 1596)
- **n missing**: --n absent ⇒ flags.get("--n") = undefined ⇒ nRaw = undefined ⇒ regex test fails ⇒ n = NaN ⇒ range check `!Number.isInteger(n) || n < 1` catches — HANDLED (line 1533-1537)
- **n=0**: Regex `/^[1-9][0-9]*$/` rejects "0" (no leading zero), n = NaN, range check catches — HANDLED
- **n="abc"**: Regex fails, n = NaN, range check catches — HANDLED
- **n negative**: "-" not decimal-only, regex fails, n = NaN — HANDLED
- **n huge (overflow)**: "999999999999999999999999" ⇒ Number() = Infinity ⇒ Number.isInteger(Infinity) = false ⇒ range check catches — HANDLED (line 1533-1537)
- **n=2.5**: Regex rejects decimal point, n = NaN — HANDLED
- **n=0x3**: Regex rejects "0x", n = NaN — HANDLED
- **n with leading zeros**: Regex `/^[1-9][0-9]*$/` rejects leading zeros (e.g., "08080") — HANDLED (line 1533)
- **pattern with spaces**: "best of n" ⇒ String(pattern) = "best of n" ⇒ unknown-pattern refusal — HANDLED
- **pattern with shell metachars**: "&" or ";" ⇒ String(pattern) includes it ⇒ unknown-pattern refusal — HANDLED
- **pattern="many-stories" with --roster**: Line 1580-1584 explicitly forbids — HANDLED
- **--roster "" empty string**: Line 1570-1572 - `--roster ""` / "," splits to EMPTY list, treated as flag-ABSENT (undefined) - HANDLED
- **--roster with trailing commas**: Split, trim, filter empty — HANDLED (line 1565-1569)
- **--cap-micro-usd validation**: Line 1543-1550 - positive integer check, rejects negative/zero/non-integer — HANDLED

## `--dir` producer/consumer semantics

- **dir created when missing**: resolveFanoutsDir (fanout.ts:69-71) returns dir; FanoutRecordStore constructor (fanout.ts:112) mkdirSync with recursive:true — YES, created
- **trailing slash**: resolveFanoutsDir doesn't normalize, but mkdirSync handles — OK (no explicit normalization needed)
- **relative cwd**: dir used directly in path joins (fanout.ts:113) — resolved against current working directory — EXPECTED
- **dir that exists as file**: statSync at fanout.ts:119 throws EISDIR → "not a directory" error — HANDLED
- **--dir for fanout vs rank**: Both use resolveFanoutsDir for same flag → one meaning, one chain — HANDLED (line 1671, 1925)

## steps-json: emitted when steps unavailable

- **steps unavailable (all-null path)**: When --steps-json absent, byRun is empty Map, stepOutputFor returns null (line 1929) — rank emits advisory ranking with score:null for all arms — VALID OUTPUT (design intent, ruling C2)
- **valid JSON when steps unavailable**: Rank doesn't emit JSON when steps absent; it emits ranking result with null scores — JSON emitted only for the ranking object, which is valid
- **NaN serialized**: The CLI prevents NaN in scores by shape-checking testResults for non-negative integers (line 1893-1907) - no NaN can reach the ranking output — HANDLED

## Exit propagation

- **engine throws unknown error**: Catch at line 1764-1766 calls report() which defaults to exit code 2 for untyped errors (line 492-493) — HANDLED
- **refusal path (exit 5/6)**: Refusal rejections (RunLockedError, fleet-busy) are caught, classified, and exit 5 or 6 per the refusal type — line 1766, 2121 — HANDLED
- **distinguished from crash**: Refusals produce FleetError with specific codes (5) and exitStatus ("transient"); crashes (bare Error) produce exit 1 with "transient" status — line 492-493, 987 — HANDLED
- **help/-h exit code**: Help path returns exit 0 (line 1246-1252) — EXPECTED

## Registry: fanout/rank registration

- **registered in same table**: src/fleet/verbs.ts:122-174 — fanout at line 122-148, rank at line 151-174 — YES, both in listVerbs()
- **probe finds them**: The CLI derives REGISTRY_FLAGS and VALUE_FLAGS from listVerbs() (line 139, 144) — probe will find fanout/rank flags — VERIFIED
- **parseArgv validates**: parseArgv checks flags against the verb entry's allowed set (line 619-626) — UNKNOWN FLAG REFUSAL — HANDLED

## Roster config

- **missing models.json / malformed**: The CLI does NOT read roster config directly; it only parses --roster flag into rosterIds array (line 1565-1572). Roster shape validation happens in dispatch/substrate, not at CLI boundary — EXPECTED (deferred validation)
- **image drift tolerance**: The diff comment (lines 10-12) notes that absent pi models.json is "treated legal" — this is per the handoff contract's minimum requirements (2 roles is minimum) — EXPECTED

## stdout purity

- **human logs on stdout**: Line 27-29 states stdout carries OUTPUT only; diagnostics go to stderr. emit() writes to stdout (line 1117); printError() writes to err (line 376) — SEPARATED — HANDLED
- **key material echoed**: The dispatch ack (line 1451) writes httpsUrl to stdout by design (line 1439-1445 comment) — this is OUTPUT to the operator who asked for the box — INTENTIONAL. Secret URLs in log streams (stderr) are redacted via INV-6 — HANDLED

## cap-hit-demo

- **destructive ops**: cap-hit-demo.ts is a separate script; this diff only touches its comment about envFile path (lines 67-69, 79). No destructive ops introduced in this chunk — NOT APPLICABLE
- **secret leakage**: Changes are comment-only (envFile path documentation). The script already uses redactSecrets (line 47) — NO NEW LEAKAGE INTRODUCED

## Windows/CI env assumptions

- **platform portability**: This repo uses bash scripts and Node.js fs APIs (statSync, mkdirSync, etc.) which are cross-platform. No bash-specific syntax in the CLI logic itself — PORTABLE
- **CI env assumptions**: No hardcoded CI-specific paths or assumptions — uses relative paths and env vars (QDS_FANOUTS_DIR) — PORTABLE

## Final verdict

**NO FINDINGS**

All identified edge cases are handled by the implementation. The CLI demonstrates robust input validation, proper exit code propagation, clean stdout/stderr separation, and correct registry-based verb/flag validation.
