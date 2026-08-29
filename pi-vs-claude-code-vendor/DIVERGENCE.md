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
- The identical/parity layer now lives in **`coms-core.ts`** (a LOCAL module,
  not vendored — no upstream counterpart). Both transports import it exactly
  like `themeMap.ts`. New shared helper/constant/env-parse logic goes there;
  transport-specific logic stays per-file. See the `coms-core.ts` section below.

## `coms-core.ts` (local shared layer — NOT vendored)

Extracted from the two transports where the code was byte-for-byte identical
(or identical after the drift fixes above). Zero behavior change — a pure
refactor covered by `tests/vendor/coms-core.test.ts`.

- `CROCKFORD` is exported (#59) so `scripts/lib/coms-smoke-helpers.ts` can
  re-export `ulid` + the alphabet instead of keeping its own copy. That copy had
  justified itself with the 3-way-merge rule, which does not apply here —
  `coms-core.ts` is local, with no upstream counterpart to merge against.
- **Pure helpers**: `ulid` (+ Crockford alphabet), `isValidHex`, `hexFg`,
  `fallbackColor` (+ `FALLBACK_PALETTE`), `parseFrontmatter`, `abbreviateModel`
  (incl. the non-string guard that historically drifted), `sanitizePeerText`,
  `secretEqual` (used only by coms.ts's shared-secret IPC auth; coms-net uses a
  bearer token), `isSafePathComponent`.
- **`envBoundedInt(env, def, { min?, max?, integer? })`** — one bounded env-int
  parser unifying coms.ts's `envPositiveInt` (now `{ integer: true, max: 2^31-1 }`)
  and coms-net's old positional `envBoundedInt(env, def, min, max)` (now
  `{ min, max }`). Superset: `integer` reproduces the old integer-only timer-knob
  rejection; without it, finite fractional values clamp as before. Every existing
  call site keeps its exact effective bounds.
- **Shared caps** (identical value AND meaning): `MAX_HOPS` (5), `MAX_INBOUND`
  (256), `MAX_FULFILLED_TOMBSTONES` (1000), `MAX_PENDING_EXIT_DISPATCHES` (64),
  `EXIT_DELIVER_BUDGET_MS` (10s), `MAX_RESPONSE_BYTES` (256 KiB),
  `MAX_RESPONSE_SCHEMA_BYTES` (32 KiB). Divergent caps (`MAX_PROMPT_BYTES`,
  `INIT_LATCH_TIMEOUT_MS`) stay in their files — see the table below.
- **`nowIso`** — `new Date().toISOString()`; was byte-identical in both files.
- **System-prompt frontmatter scan**: `findSystemPromptPath` (scans argv for
  `--system-prompt`, falling back to `--append-system-prompt`; accepts both
  `--flag path` and `--flag=path`; requires an existing `.md` regular file) and
  `readFrontmatterFromArgv` (reads it and returns `parseFrontmatter`'s
  name/description/color, `{}` on any read failure). `readFrontmatterFromArgv`
  was byte-identical; `findSystemPromptPath` differed only in comment wording
  and ternary line-wrapping — same AST, same behavior. Extraction adds a
  `node:fs` import to `coms-core.ts` — **this is a deliberate, permanent
  layering change**: `coms-core.ts` is no longer pure-helpers-only, it now
  also owns the two filesystem-touching functions above (both were already
  doing `fs` I/O in the pre-extraction transports; extraction only moved
  them, it didn't add I/O that wasn't there). The file marks the boundary
  with a `// ━━ Filesystem-touching helpers ━━` banner above `nowIso`'s
  successor — everything above that banner is pure, everything below reads
  the filesystem. Kept as one file rather than split into a separate
  `coms-core-io.ts`: both transports already import `coms-core.ts` as a
  single unit like `themeMap.ts`, and — per the 3-way-merge rule above —
  every additional file is permanent merge surface against a future
  `0ed11f44` sync, so a doc-only boundary was chosen over a structural split
  for no behavioral gain.
- **`WireRecord` / `isWireRecord`** (#60) — the wire-protocol trust-boundary
  type: a value decoded from a peer/hub (socket line, SSE `data:`, hub JSON) is
  a non-null non-array object and nothing more, so every field reads as
  `unknown` until a runtime check narrows it. Both transports use it instead of
  typing decoded data as `any` or casting it to a rich interface.
- **`isDuplicateRegistration`** — the `/already|duplicate/i` predicate. coms.ts's
  `registerFlagSafe/ToolSafe/CommandSafe` and coms-net's `registerFlagOnce` both
  use it, but their WRAPPERS stay per-file: coms-net's `registerFlagOnce`
  additionally gates on a `KNOWN_COMS_FLAGS` allow-set (stricter than coms.ts's
  blanket swallow), so only the predicate is shared. Within coms.ts the three
  wrappers now share a local `ignoreDuplicate(register)` (F080) — the identical
  try/catch body only; the three named wrappers stay, since their arities and
  generics differ. Still per-file, not moved to core, for the same reason.

### Deliberately NOT extracted (remaining manual-parity surface)

Left in each transport because the two implementations differ in semantics or
are transport-coupled; unifying would not be zero-behavior:

- **Replay tombstones** — coms.ts `isDuplicateMsgId`/`markFulfilled` (delete-on-
  read expiry, `>=` cap, inline 1h TTL) vs coms-net `tombstoneFulfilled`/
  `markInboundFulfilled` (`.has()` check, `>` cap, `FULFILLED_TTL_MS`, plus the
  queue+FIFO drop in the same terminal step). Different semantics — left in place.
- **Registration wrappers** — `registerFlagSafe/ToolSafe/CommandSafe` vs
  `registerFlagOnce` + `KNOWN_COMS_FLAGS` (see above).
- **`readCliFlags` / `CliFlags`** — NOT a parity pair. coms-net's version is a
  strict superset: it also reads `--server-url` / `--auth-token` (flags only
  coms-net registers) and its `CliFlags` carries the matching `serverUrl` /
  `authToken` fields. Sharing it would make coms.ts read two flags its parser
  never declares. Transport-shaped, like the `CliFlags` type itself.
- **Inbound-queue / turnQueue FIFO attribution, renderPool/widget code,
  agent_end response capture, transport/registry/SSE logic** — transport-specific
  by nature; out of scope for this incremental extraction.

## `coms.ts` (local Unix-socket IPC transport)

- **Provenance header corrected (DF2.9)** — the file docblock claimed the file
  was vendored "from the pi-mono coms extension". It was not: it comes from
  `disler/pi-vs-claude-code` `extensions/` at commit `0ed11f44`, exactly as
  `package.json` `_provenance` records. The header now says so. Audit hygiene,
  not a legal defect — the vendored `LICENSE` (MIT © 2026 IndyDevDan) plus
  `_provenance` already exceed MIT's requirement. `coms-net.ts` carried no such
  claim and is byte-unchanged by this story.
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
- **Honest inbound-envelope typing (#60)** — `isValidEnvelope(obj: unknown)`
  now narrows to a local `WireEnvelope` (`WireRecord` + the four string fields
  it actually checks) instead of claiming `Envelope`, and `connHandler` passes
  that to `handlePrompt`/`handleResponse`/`handlePing` instead of casting
  `as PromptEnvelope` / `as ResponseEnvelope` / `as PingEnvelope`. The
  `Prompt`/`Response`/`Ping` interfaces now describe only what this agent
  SENDS. Every field the handlers read (`hops`, `prompt`, `secret`,
  `response_schema`, …) was already runtime-checked; the compiler now enforces
  that a newly added read is checked too. One added runtime term: `typeof
  env.hops !== "number"` in handlePrompt (redundant with the existing
  `Number.isInteger`, present so the value narrows). `ResponseEnvelope.response`
  and the `pendingReplies` result shape are `unknown`, not `any`, which let the
  `(winner as any)` reads in `coms_await` drop their casts.
- **Empty error string is an error (#60 review)** — `coms_await` and `coms_get`
  classify a settled reply with `winner.error != null` / `r.error != null`
  instead of truthiness. `handleResponse` keeps whatever string the peer sent
  (`typeof env.error === "string" ? env.error : null`) and `isValidEnvelope`
  does not constrain `error`, so a peer-supplied `error: ""` reached the caller
  as a success carrying an undefined response.

- **Tool-argument boundary narrowed (F080)** — issue #60 typed the *wire*
  boundary and left the *tool-argument* one casting to `any`. All four
  `renderCall(args, theme)` handlers (`coms_list`, `coms_send`, `coms_get`,
  `coms_await`) now declare `args: WireRecord` instead of reading
  `(args as any).field`. renderCall receives raw — possibly still-streaming —
  model output, not the TypeBox-validated value `execute` gets, so `WireRecord`
  is the honest type and the compiler now refuses an unsanitized read.
  **Behavior change (the point of the story):** all four were rendering peer/
  model-controlled strings into the TUI unsanitized (`(args as any).target ??
  "?"`); they now go through `sanitizePeerText`, closing the same ANSI
  terminal-injection channel coms-net's `coms_net_send` renderCall already
  closed. Side effect: the `coms_send` prompt preview is capped at
  `sanitizePeerText`'s 64 chars before the existing 60-char slice — no visible
  difference, the preview was already shorter. Covered by
  `tests/vendor/coms-net.test.ts`, which asserts the compile-time force with a
  `@ts-expect-error` as well as the runtime sanitization.

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
- **Honest SSE/card typing (#60)** — `makeSseParser`'s `data`, `handleSseEvent`,
  `sanitizeCard`, `sanitizeCardPatch`, `responseSizeBytes`, the two inbound
  handlers and the reply/resync long-poll bodies take `unknown` / `WireRecord`
  instead of `any`. `sanitizeCard` no longer spreads unchecked wire fields into
  a declared `AgentCard`: `session_id`/`provider`/`started_at` are typechecked,
  `explicit` is `=== true`, and `context_used_pct`/`queue_depth` go through
  `wireFiniteNumber` (non-finite → `NaN`, which every consumer already screens
  with `Number.isFinite`, so rendering is unchanged). `sanitizeCardPatch` builds
  a fresh patch of known fields only — an unrecognised wire key had no reader.
  The `pendingReplies`/await-racer result shape is `unknown`, which removed the
  `(winner as any)` reads in `coms_net_await`. Left as-is: `httpFetch` still
  returns `any` (15 call sites — retyping it is a separate, larger change).
- **Tool-argument boundary narrowed (F080)** — same change as `coms.ts`: the
  four `renderCall` handlers take `args: WireRecord`, and the `execute`
  handlers dropped their `(params as any)` casts (`project`,
  `include_explicit`, `conversation_id`, `response_schema`, `msg_id`,
  `timeout_ms`) in favour of the TypeBox-derived `Static<TParams>` the host
  already validates against — those casts were pure cruft and hid the real
  types. No behavior change here: coms-net's renderCalls were already
  sanitizing, except `coms_net_list`'s `project`, which now does too. Still
  left as-is: `httpFetch`'s `any` return (15 call sites — a separate change).
- **`pool_snapshot` validates before mutating (#60 review)** — `handleSseEvent`
  returns on a non-array `agents` instead of clearing `peerCards` first and
  falling back to `[]`. One malformed frame from the hub used to wipe every
  known peer and leave the pool empty until the next good snapshot.
- **Empty error string is an error (#60 review)** — same change as `coms.ts`:
  `coms_net_await` (both the SSE-resolved fast path and the race winner) and
  `coms_net_get`'s local-entry path use `error != null`. `handleInboundResponse`
  preserves a hub-supplied `error: ""` (`typeof data.error === "string" ?
  data.error : null`), which the truthiness check reported as a blank success.
  The server-derived `coms_net_get` fallback is unchanged — it keys off the
  hub's own `status` field, not this value.

### Intentional value differences vs `coms.ts`

| Constant | `coms.ts` | `coms-net.ts` | Why |
|---|---|---|---|
| `MAX_PROMPT_BYTES` | `256*1024` | `200_000` | Transport-specific HTTP cap; coms.ts sizes against the local-IPC 16 MiB×256 envelope pin, which has no HTTP analog. |
| `INIT_LATCH_TIMEOUT_MS` override envelope | default `30_000`; env `PI_COMS_*`, integer-only, no floor, max `2^31-1` | default `30_000`; env `PI_COMS_NET_*`, clamp `[1_000, 300_000]`, fractionals accepted | Defaults are equal but the env override envelope differs per transport (net enforces a 1 s floor / 5 min ceiling). |

All other shared caps (`MAX_INBOUND`, `MAX_PENDING_EXIT_DISPATCHES`,
`MAX_FULFILLED_TOMBSTONES`, `EXIT_DELIVER_BUDGET_MS`, `MAX_RESPONSE_BYTES`,
`MAX_RESPONSE_SCHEMA_BYTES`) now come from `coms-core.ts`, so they cannot drift;
`INIT_LATCH_TIMEOUT_MS` is default-equal only and stays per-file (see table).

## `themeMap.ts`

- Local import shared by `coms.ts`/`coms-net.ts`; vendored to keep the
  extensions self-contained.
- **`THEME_MAP` kept intact** — the full upstream table ships unchanged (only
  coms/coms-net are actually vendored) so the file diffs cleanly on re-vendor.
