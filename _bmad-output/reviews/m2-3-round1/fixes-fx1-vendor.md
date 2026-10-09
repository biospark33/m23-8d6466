# F-011 fix — fx1-vendor (m2-3, review round 1)

File: `pi-vs-claude-code-vendor/self-compact/tests/e2e/failure-recovery.test.ts` (comment-only change, no other edits, no commit).

Corrected the factually wrong closing clause of the timeout comment above the `test("failed compaction keeps the note and the lock...")` call: node:test honors `options.timeout` natively, so the comment now says the native runner applies no DEFAULT timeout (the option only tightens, never loosens, its behavior), while bun's repo-wide sweep defaults every test to 5s and needs the explicit ceiling. The rest of the comment block is untouched.

Focal check (`node --test --test-concurrency=1 tests/e2e/failure-recovery.test.ts`, from the self-compact dir):

```
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

Note: the git diff for this file also shows the comment block + `{ timeout: 600_000 }` option themselves — those were added earlier in this round (2026-10-08, uncommitted working-tree change); fx1-vendor's edit touched only comment wording within that block.
