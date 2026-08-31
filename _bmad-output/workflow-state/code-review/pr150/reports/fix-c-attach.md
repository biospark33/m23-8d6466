# PR #150 — fix-c-attach (cluster C)

Files owned: `src/fleet/attach.ts`, `tests/fleet/attach.test.ts`. No other files touched. No commit.

## Verdict table

| # | Sev | Verdict | Fix |
|---|-----|---------|-----|
| 8 | MEDIUM | **fixed** | Length guard now measures `sanitizeForMessage(message).length` against `ATTACH_MESSAGE_CHAR_CEILING` (imported from steering.ts in place of `DIRECTIVE_TEXT_CHAR_CEILING`), so acceptance ⇒ no truncation at the fold (steering.ts:519 caps post-sanitize). |
| 19 | LOW | **fixed** | `readAck`'s parse loop now keeps the `row.messageId` dereference INSIDE the try (mirroring `drain()`); a literal `null` line is skipped as a non-object line instead of throwing an uncaught TypeError out of the poll. |
| 20 | LOW | **fixed** | Over-ceiling is no longer a bare `Error` throw (→ transient/exit-1 "retry me"). New `AttachResult` arm `{ outcome: "message-over-ceiling"; messageId; requestId?; messageChars; ceilingChars }` — a permanent refusal expressed as a result, same guard as #8. |
| 21 | LOW | **fixed** | Engine-leg `ack` now `chmodSync(acksPath(), 0o600)` after every append — `mode: 0o600` only applies at creation; mirrors APPEND_SCRIPT's trailing `chmod 600 "$f"` on the inbox leg. |
| 22 | LOW | **fixed** | `ACK_READ_SCRIPT` is now `tail -c 1048576 "$root/acks.ndjson"` (new module constant `ACKS_READ_CAP_BYTES`, mirroring `INBOX_READ_CAP_BYTES`). Tail-bounded so the newest acks survive; argv stays a constant script (only interpolation is the numeric literal), payload-free, and an absent file still exits non-zero like `cat`. A partial first line of the window is skipped by `readAck`'s parse loop like a torn line. |

False positives: none. Deferred: none.

## gitnexus impact (run before edits, `node .gitnexus/run.cjs impact <symbol> --direction upstream --repo QDS-Factory`)

- `attachToRun`: risk **LOW**, 1 direct caller (`scripts/fleet.ts:run`), 1 affected process, exact.
- `localSteeringInbox`: risk **LOW**, 1 direct caller (`scripts/pipeline-run.ts:main`), 1 affected process, exact.
- `AttachResult`: type, not indexed ("Target not found") — consumers verified by grep instead: `src/fleet/attach.ts`, `scripts/fleet.ts` (structural narrowing on `res.outcome`), `tests/fleet/attach.test.ts`, `tests/fleet/gate-verbs.test.ts` (comment only).

## Behavior-change flags (intentional)

1. **Over-ceiling message: throw → result arm.** `attachToRun` no longer throws a bare `Error` for an over-ceiling message; it returns `{ outcome: "message-over-ceiling", ... }`. The guard threshold itself also changed semantically: post-sanitize length vs `ATTACH_MESSAGE_CHAR_CEILING` (was raw length vs `DIRECTIVE_TEXT_CHAR_CEILING`). Messages that used to be silently tail-truncated at the fold are now refused up front; messages at exactly the post-sanitize ceiling are accepted and fold untruncated (pinned by test).
2. **New arm carries `messageId`/`requestId?`** deliberately, so `scripts/fleet.ts:2919` (`res.requestId`) and `:2971` (`res.messageId`) keep compiling unchanged. The minted `messageId` on this arm is a correlation handle only — nothing is appended (documented on the arm).
3. **`null`-only acks file → `acks-unreadable`.** A line whose dereference throws no longer counts toward `parsedAny`; previously such a line crashed the poll before the question could be asked. Mixed files (null line + valid ack) still ack.
4. **Ack read is windowed.** Poll ticks read at most the last 1 MiB of acks. An ack older than the newest 1 MiB (~14k+ acks) would be missed — accepted per the same reasoning as `INBOX_READ_CAP_BYTES` (reaching that means the engine stopped draining long ago).
5. **Ack append now chmods.** `ack()` is marginally more expensive (one extra syscall per ack) and can now throw from the chmod where it previously couldn't; ack throws are already contained engine-side (steering.ts:550 "steering inbox ack failed").

## Cross-cluster contract (#8, C+F)

C side (this report): library guard + typed refusal arm, as fixed above. F side: verified already aligned at PR head — `scripts/fleet.ts:2943` handles `message-over-ceiling`, and the CLI pre-check at `scripts/fleet.ts:2905` is F's to align to the post-sanitize rule (their cluster, not touched here). `tests/fleet/gate-verbs.test.ts` exec doubles match on `script.includes("acks.ndjson")`, which the `tail -c` script still contains — no cross-cluster test breakage.

## Tests added (tests/fleet/attach.test.ts, +6)

- `the length guard measures the POST-sanitize length and refuses as message-over-ceiling` — 4000 raw newlines (8000 post-sanitize) refused with `messageChars`/`ceilingChars`/`requestId` pinned; zero execs, no inbox write; plain-ASCII 4001 also refused. (#8, #20)
- `a message AT the post-sanitize ceiling is accepted and folds without truncation` — 2000 newlines = exactly 4000 post-sanitize; acked; folded context ends with the full sanitized string. (#8)
- `a literal \`null\` ack line is skipped, not an uncaught TypeError` — null line + valid ack → `attach-acked`. (#19)
- `an acks file of ONLY \`null\` lines is unreadable, not a thrown TypeError` — → `attach-not-acked`/`acks-unreadable`, bails early. (#19)
- `a pre-existing lax acks file is tightened to 0600 on ack` — 0644 acks file → 0600 after the engine acks. (#21)
- `the ack poll reads a bounded TAIL of an ever-growing acks file` — 1.1 MB acks file with the match at the tail → `attach-acked`; argv pinned to `tail -c 1048576`, no stdin on ack reads. The behavioral half passes under the old `cat` too (FakeDriver has no stdout cap) — the argv pin is the regression assertion, noted in the test comment. (#22)

## Verification

- `bun test tests/fleet/attach.test.ts` → exit 0, **16 pass / 0 fail** (log: /tmp/qds-fix-c.log; fail-grep clean).
- `bunx tsc --noEmit` → **0 errors** (repo-wide, at PR head with parallel fixers' changes present).
- `bunx biome check src/fleet/attach.ts tests/fleet/attach.test.ts` → **clean** (one redundant-`continue` lint found and fixed during the wave).
