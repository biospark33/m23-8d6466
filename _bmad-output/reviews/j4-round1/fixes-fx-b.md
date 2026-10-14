# FX-B fixes (R1-17)

- `appendRecord` is triage-only again (validates with `TriageRecordSchema`, same messages as origin/dev).
- New `appendMachineStateRecord(outDir, record): "written" | "duplicate"` validates with `MachineStateRecordSchema`, dedupes by `recordKey`, and appends. Both share the private `appendValidated` helper. The helper reads the target file with the same schema, so a foreign-arm line fails loudly.
- `readRecords` stays triage-only. `readCorpusRecords` and `CorpusRecordSchema` are kept: host-pack.ts still uses the union reader for its paid-ask dedupe.
- `scripts/corpus/index.ts` exports `appendMachineStateRecord`.
- `tests/scripts/corpus/machine-state.test.ts` updated: appendRecord refuses a machine record, appendMachineStateRecord writes/dedupes/refuses triage and bad dispositions, mixed-file protection in both directions.
- Gates: `bun test tests/scripts/corpus/` 47 pass, 0 fail; biome clean; tsc has no errors in my files.
