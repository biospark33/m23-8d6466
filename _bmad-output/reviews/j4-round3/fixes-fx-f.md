# FX-F fixes (J4 round 3)

| Row | Change | Where | Test |
|---|---|---|---|
| R3-01 | core `deterministicOrder`: non-finite scores last, total order | host-pack.ts `scoreKey`/`deterministicOrder` | host-pack.test.ts "R3-01" |
| R3-02 | `L8_MAX_FINDINGS_PER_CALL = 20`; excess = `capped` miss | host-pack.ts l8Prefilter | "R3-02" |
| R3-03 | lens/runId validated before the ask; `invalid-record` miss | host-pack.ts l8Prefilter | "R3-03" |
| R3-05 | inject machineStateCorpusDir + corpusDir tmp dirs | fleet-observe-pack.test.ts | (test itself) |
| R3-06 | per-hook deadline clamped to unspent pass hook budget | observe.ts runTickHook | observe-ontick.test.ts "R3-06" (fails without fix, 5s) |
| R3-07 | only `mode === "live"` selects measured corpus | host-pack.ts packContext | "R3-07" |
| R3-08 | recorded hotspots seed worthByPath from `worth_brief=` in rationale | l9-repo-sweep-triage.ts rank | l9 test "R3-08" |
| R3-09 | L8 record id = `run/finding@sha256(text)[:12]`; would-keep set still keyed run/finding | host-pack.ts l8Prefilter | "R3-09" (+ id-format assertion) |
| R3-11 | comment: scan is a tripwire; guarantee is the literal | host-pack.test.ts AC5 | n/a |
| R3-13 | `resolveLockfilePath`: FACTORY_ROOT/bun.lock | l9-repo-sweep-triage.ts | l9 test "R3-13" |
