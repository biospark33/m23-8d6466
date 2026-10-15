# FX-E fixes (J4 round 2)

- R2-03: `resolveTriageCorpusDir` selects the measured corpus only for `mode === "live"`; everything else routes to `mock/`. `Judge.mode` is now required. Test: a spy without mode routes to mock, and a `@ts-expect-error` proves the type requires it.
- R2-07: the per-call cap counts only hotspots that will be asked. The already-recorded check runs first, and recorded hotspots remain in the logged would-be order. Test: 10 pre-recorded + 65 total gives 50 asks, 10 already-recorded, 5 capped, 65 in would_order.
- R2-08: new pure `resolveProvenanceDir()` anchors to FACTORY_ROOT. Test asserts the resolved path and that an injected dir wins.
- R2-18: every `l9-triage` log line carries `answer_mode` ("mock"|"live"). TriageRecordSchema is untouched. Test covers both modes.

Verification: l9 test file 27 pass; biome clean; tsc clean for these files; `git status` of `_bmad-output/judgment` is empty.
