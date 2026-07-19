# Divergence ledger — vendored coms extensions

These files are vendored from upstream `disler/pi-vs-claude-code` at commit
**`0ed11f44`** (pinned in `package.json` `_provenance`). Everything below is a
**local** change made after vendoring, mostly across ~30 review-round commits
(`git log --oneline -- pi-vs-claude-code-vendor/`).

## Rules for maintainers

- **Any future upstream sync MUST 3-way merge against `0ed11f44`** — do not
  overwrite these files with a fresh upstream copy, or every hardening below is
  silently reverted.
- **Any new local edit gets a row here** (what + why, 1–2 lines).
- `coms.ts` and `coms-net.ts` share intent but are separate transports (local
  Unix-socket IPC vs HTTP/SSE hub). Constants "mirror" only where a comment says
  so; where values intentionally differ, the code comment states why.

## `coms.ts` (local Unix-socket IPC transport)

- **Shared-secret IPC auth** — inbound envelopes and responses carry a
  shared secret; `secretEqual` compares in constant time.
- **Response-secret auth** — responses authenticated separately from the
  request path.
- **Size caps** — `MAX_PROMPT_BYTES` 256 KiB, `MAX_RESPONSE_BYTES` 256 KiB,
  `MAX_INBOUND` 256, `MAX_COMPLETED_REPLIES` 256, `MAX_PENDING_EXIT_DISPATCHES`
  64, sized against a 16 MiB × 256 envelope-queue memory pin.
- **Replay tombstones** — `MAX_FULFILLED_TOMBSTONES` 1000, prune-expired-then-
  evict-oldest so a unique-id flood can't pin memory.
- **Init latch** — `INIT_LATCH_TIMEOUT_MS` bounds the session_start /
  session_shutdown poll spin.
- **Exit-fallback budget** — `EXIT_DELIVER_BUDGET_MS` 10s caps total blocking
  spawnSync time at process exit.
- **POSIX-only guards** — `makeEndpoint` throws on win32 (no named-pipe ACL
  equivalent of the 0700 socket dir); socket-path length capped at 100 bytes
  with a per-uid tmp fallback.
- **Peer-text sanitization** — `sanitizePeerText` strips C0/DEL/C1 control chars
  (ANSI terminal-injection channel) and caps length.
- **`abbreviateModel` guard** — `typeof model === "string"` so a non-string
  peer field can't throw out of the TUI render callback.

## `coms-net.ts` (HTTP/SSE hub transport)

Shares the auth/cap/tombstone/init-latch/sanitization hardening above, plus
transport-specific work:

- **Hop-limit** — `MAX_HOPS` 5; env override validated (rejects 0/-1/Infinity)
  to stop runaway message chains.
- **SSE abort/reconnect hardening** — cancel the SSE reader on disconnect;
  abort reconnect on terminal HTTP errors (401/403/4xx); watchdog
  (`SSE_WATCHDOG_FACTOR` 3) tears down half-open connections; a
  `reconnectInFlight` latch prevents double-open; generation counter drops
  stale reconnects; buffer capped at `SSE_BUF_CAP_BYTES` 16 MiB.
- **Response-schema cap** — `MAX_RESPONSE_SCHEMA_BYTES` 32 KiB so a peer can't
  inject up to the SSE cap of schema JSON per prompt.
- **Registry corruption guards** — defensive parse of the coms-net registry;
  clean-shutdown heartbeat on terminal HTTP errors.
- **Secret redaction** — `safeError` redacts secrets (longest-match-first) from
  error strings before they reach tool output.
- **win32 spawn-arg reject-set** — exit-fallback spawn args reject CR/LF and
  cmd delayed-expansion `!`.
- **HTTP body cap + abort** — over-cap response bodies are torn down like the
  SSE error path rather than lingering until GC.

### Intentional value differences vs `coms.ts`

| Constant | `coms.ts` | `coms-net.ts` | Why |
|---|---|---|---|
| `MAX_PROMPT_BYTES` | `256*1024` | `200_000` | Transport-specific HTTP cap; coms.ts sizes against the local-IPC 16 MiB×256 envelope pin, which has no HTTP analog. |

All other shared caps (`MAX_INBOUND`, `MAX_PENDING_EXIT_DISPATCHES`,
`MAX_FULFILLED_TOMBSTONES`, `EXIT_DELIVER_BUDGET_MS`, `INIT_LATCH_TIMEOUT_MS`)
are kept numerically equal to `coms.ts`.

## `themeMap.ts`

- Local import shared by `coms.ts`/`coms-net.ts`; vendored to keep the
  extensions self-contained.
- **`THEME_MAP` kept intact** — the full upstream table ships unchanged (only
  coms/coms-net are actually vendored) so the file diffs cleanly on re-vendor.
