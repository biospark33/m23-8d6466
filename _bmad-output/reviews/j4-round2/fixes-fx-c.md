# J4 review round 2: FX-C fixes

Owner rows: R2-01, R2-09, R2-11, R2-12, R2-13, R2-16, R2-17, R2-19. All PATCHED. Nothing committed.

| Row | Fix | Where | Test (fails on the pre-fix code) |
|-----|-----|-------|------|
| R2-01 | An already-recorded L8 finding re-applies its recorded answer (disposition `DISMISS` plus the `is_real_defect` noul from its rationale) to the would-filter set, so the filter is idempotent across passes. It emits one `skip: "already-recorded"` line that carries `would_signal`. An unparseable rationale is not filtered (fail-open). | `host-pack.ts` `recordedFor`, `recordedWouldFilter`, l8Prefilter loop | `host-pack.test.ts` "an already-recorded finding keeps its recorded disposition (R2-01)". It replaces the old "already-recorded never filtered" test. |
| R2-09 | Each L8 ask is wrapped in `withTimeout(…, ctx.l7AskDeadlineMs)`. A hung ask becomes an `ask-deadline` miss. The lock is still released in `withCorpusLock`'s `finally`. | `host-pack.ts` l8Prefilter | "each L8 ask has a deadline … (R2-09)". On the old code it hangs to the 5 s test timeout. |
| R2-11 | The source scan now forbids `process.env`, `Bun.env`, `import.meta.env`, `node:process`, `Bun.file(`, `readFileSync`/`readFile(`/`createReadStream`, and any quoted `.json/.jsonc/.yaml/.yml/.toml/.env/.ini`/`rc` path. The env test sets 11 plausible arming vars to `1` and proves nothing changes. | `host-pack.test.ts` AC5 | scan + env test |
| R2-12 | `CorpusReadError.torn` is true only for a positively identified parse failure (SyntaxError) or schema failure. Any other read error (EACCES, EMFILE, …) is a `corpus-io` miss and the shard is left untouched. Only a torn shard is renamed aside. | `host-pack.ts` `readCorpusOrThrow`, l7Ask | "an I/O error on a healthy shard is a `corpus-io` miss; NOT set aside (R2-12)" uses chmod 000. History survives: the next tick gives `state-unchanged`. |
| R2-13 | The L7 shard is read with `MachineStateRecordSchema`, the schema the append uses (`readMachineStateShard`). A triage line is torn, so the result is `corpus-unreadable` before any ask, the shard is set aside, and the next tick records. | `host-pack.ts` | "a triage (foreign) line in a shard is `corpus-unreadable` BEFORE the ask (R2-13)": judge calls stay 0. |
| R2-16 | The `state-unchanged` skip applies only when `last.answer_mode === ctx.client.mode`. | `host-pack.ts` l7Ask | "state-unchanged only skips within the same answer_mode (R2-16)" |
| R2-17 | The edge walk now also covers `tests/`. Only L9's module, L9's test and this suite are exempt. A tests/ control was added. The executed cut copies only `src scripts tests oci config cli-anything pi-vs-claude-code-vendor package.json tsconfig.json bun.lock`, and `node_modules` is the ONE symlink (asserted). It runs `bun test tests/autonomy/` and `tsc --noEmit -p tsconfig.json` in parallel inside the L9-less tree. The tmp tree is removed in `finally`. Runtime is about 16 s. | `l9-cut-boundary.test.ts` | Before `cli-anything` was copied, tsc in the tree failed, which shows the typecheck is live. |
| R2-19 | Exported the pure selector `observeTickHookFor(deps)` and `runObserveSweep` now spreads it. Arms: no deps gives the default hook; deps without `judgmentPack` gives `{}`; deps with `judgmentPack` gives a hook on those deps. | `scripts/fleet.ts` (J4 import + FleetDeps region, plus the sweep literal) | `fleet-observe-pack.test.ts` "observeTickHookFor … (R2-19)". The production hook is invoked against a cleanly-absent box journal (reads the default path, writes nothing). Deleting the production arm fails it. |

## Gates (4 passes, last two identical)
- `bun test` on host-pack, host-pack.e2e, l9-cut-boundary and fleet-observe-pack: 56 pass, 0 fail (`/tmp/fxc-auto-p4.log`).
- `tests/fleet/cli.test.ts`: 187 pass, 1 fail. The failure is the known dev-red EMFILE test ("a TRANSIENT errno while reading --brief …"), and the log shows `EMFILE: too many open files`.
- `bunx tsc --noEmit`: 0 errors. Biome on the 6 owned files: clean.
- `git status --porcelain --untracked-files=all -- _bmad-output/judgment`: empty.
- host-pack.ts and host-pack.test.ts: zero `l9` matches.

## Notes
- L8 reuses `PackDeps.l7AskDeadlineMs` / `L7_ASK_DEADLINE_MS` as its per-ask bound (documented on the field) instead of adding a second knob.
- `fleet.ts` gains one `import type { ObserveTickInfo }` line next to the J4 import, so the J4 region did not need to edit the shared observe import on line 131.
