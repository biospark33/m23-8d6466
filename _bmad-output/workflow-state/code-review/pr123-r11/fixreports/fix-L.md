Triage and sources read. Key discovery: `run-record.ts:859`'s blind sweep treats NaN-owner temps as immediately sweepable (`rmSync` runs regardless when owner doesn't parse), so a name-grammar change is the right lever, not parsing tricks. Let me run gitnexus impact on the symbols I'll edit.
Now let me check test pins on temp grammar, hostTag, WAL mode, and the signal tests before editing.
Analysis complete. Design decisions locked in:

- **L3**: run-record's blind sweep (line 859) `rmSync`s *any* `.tmp` whose pid parses NaN — so grammar tricks inside the stem can't save us. Moving run-lock claim temps off the `.tmp` suffix is the only safe lever, and it fully closes the window without touching run-record.ts.
- **L6**: reliable detection needs issue-level knowledge the path resolver doesn't have — DEFERRED with rationale.
- **L7**: bijective `-XX`/`--` byte-escaping of `lockHost()` kills folding collisions outright (percent-encoding with escaped escape-char).

Starting with run-lock.ts.
The Proxy is over-clever; a plain accessor is more legible. Replacing it.
Now I need to update every reference to `held`, `destructive`, `signalsInstalled`, `unwinding`.
Now the L2 dirty-release retry policy — replace the `held.delete` head with read-verify-then-delete-on-success:
I made a typo — used `#` comment chars instead of `//`. Fixing.
Now add the `held.delete` at each success/failure exit of releaseRunLock.
Clean up the stray mid-edit note comment.
Now L1 — the survived-signal path. Reorder so locks are NOT released before the re-raise is proven lethal.
Now reviewing my L1 edit critically before finalizing — the `#` chars are typos, and the reorder has a fatal flaw worth rethinking carefully.
Careful reconsideration: my draft breaks the primary path — a death-by-signal never runs exit handlers, so release-before-raise IS the only mechanism the normal Ctrl-C path has (that was the original DF2.5 bug). The finding's actual harm is the *survived* path proceeding lock-less. Correct shape: keep the lethal bet, but put the released claims BACK if the process survives (kill-throw or disposition-blocked). Rewriting properly.
The rollback needs to know which claims were actually released. Simplest correct shape: snapshot `held` entries before releasing, and re-claim only those that came off — `claim()` itself is exclusive, so a contender that grabbed the path in the window wins cleanly.
That edit accidentally deleted a blank line — restoring it and inserting the rollback helper before `releaseHeldRunLocks`.
Updating the installer docstring to match the new rollback contract.
Now L4 (guarded `fsyncDir` close) and L7 (bijective hostTag) and L3+L10 (temp grammar + sweep bounding).
Bijective and reversible. Now L3 — move run-lock claim temps off the `.tmp` suffix (removes them from run-record's blind sweep entirely) and L10 — bound the readdir sweep.
Now L9 — unreadable lock gets distinct rendering, with rm advice suppressed.
File is intact — the earlier empty greps were a shell quoting artifact. Running typecheck and focal tests now.
All 42 pass. Now cli.test.ts (large fleet CLI suite — includes lock + costLedgerOpts paths).
All green. The cli.test timeout was a one-off parallel-load flake (140/140 on re-run). Now cost-ledger-opts.ts: L5 migration.
Now verify the L5 migration behavior end-to-end with a live probe, plus the L2 retry and L8 dual-instance properties.
The L1 probe exposed a real flaw in my rollback: `releaseHeldRunLocks` deletes successful releases from `held`, so rolling back *from `held`* finds nothing and the lock stays gone. The rollback must run from a pre-release snapshot. Fixing.
Rollback now provably restores the lock file. Re-run all focal suites after the snapshot fix.
The failures are an artifact of my shell's cwd (`process.cwd()`-relative CLI path), not the code. Running from the repo root.
All 190 pass. Final gates: biome on touched files, tsc, and a check of the L6/L3-coordination notes.
