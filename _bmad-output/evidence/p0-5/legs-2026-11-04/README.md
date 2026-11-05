# P0.5 legs evidence — 2026-11-04 window (register item 3d)

Capture-verbatim logs from the four P0.5 closure legs (decision register item 3d),
run on this host against pi-lens 3.8.71 (`pi install npm:pi-lens@3.8.71`) with
`PI_LENS_ROOT=~/.pi/agent/npm/node_modules/pi-lens`. No evidence file was edited
after capture; classifications below are the reading notes, corrections live
here and in the drivers, never in the logs.

## Leg a — mode-json agent e2e, TS type error (AC1 core)

`leg-a-mode-json-ts-error.jsonl` — `pi --mode json --print --provider anthropic
--model claude-haiku-4-5` in a scratch git repo containing `type-error.ts` (the
same TS2322 fixture the verify harness uses) + `tsconfig.json`.

OBSERVED: the agent called `lsp_diagnostics` (7 tool events), the tool returned
structured diagnostics over the `--mode json` transport:

```
Primary LSP (typescript): 1 diagnostic.
L4:7: error[typescript] (2322): Type 'number' is not assignable to type 'string'.
```

Severity, source, error code, position — full structured payload with a real
LLM agent driving. This is the "--mode json diagnostic payload" proof: the
payload previously validated over MCP stdio arrives intact over the agent
transport. (AC1's aw:<hash> id clause: the verify harness's observed-id probe
did NOT observe pi-lens assigning an id — `idObserved:false`,
`idProvenance:"derived+native-parity"` with `matchesNative:true` in the
2026-11-04 strict run; aw: ids are turn-end aggregations, not per-tool-result
fields, so they are not present in these agent logs either. The id contract is
proven as DERIVED parity, never as an observed assignment.)

## Leg c — python-lsp discovery with a real assertion (pyright)

`leg-c-mode-json-python-warning.jsonl` — same transport, `unused-import.py` +
`pyrightconfig.json` (`reportUnusedImport: "warning"`).

OBSERVED: real pyright finding over the agent transport:

```
L1:8: warning[Pyright] (reportUnusedImport): Import "os" is not accessed
```

This is the "Python LSP discovery (fixture only, no assertion)" open item
closed with a live agent-run assertion: the fixture's expected warning fired,
with the expected rule, at the expected position.

## Leg b — secret-scan emit-block (NFR-SEC-3 + INV-1): OBSERVED (post-CR corrected)

Six logs document the chain. What each proves:

1. `leg-b-ts-error-stop-block.jsonl` — **the block mechanism observed live** in
   a real `--mode json` agent session: a 🔴 STOP turn-end blocker (TS2322
   redeclare) reached the agent, which received and narrated it ("The pi-lens
   notice about variable redeclaration..."). The promotion+delivery path works
   end-to-end over the agent transport.
2. `leg-b-rpc-model-refusal.jsonl` — the agent (claude-haiku-4-5) REFUSED to
   write a slack-token-shaped literal even as a declared test fixture ("I'm not
   going to write that file as-is... credential-in-source-control issue"). A
   secrets-blocker leg cannot rely on an agent writing the secret itself.
3. `trivy-db-warmup.log` + direct-CLI runs — trivy 0.76.1 secret detection is
   live (slack-access-token HIGH fired on a synthetic token file), but its
   ruleset no longer contains the generic AWS access-key rule (`AKIA…` shapes
   do not fire; only maven/slack-family rules matched in debug output), and
   pi-lens's own `TrivyClient.scan()` runs it clean end-to-end once the
   `trivy.enabled` + dependency-manifest gate is satisfied.
4. `leg-b4-mcp-first-attempt.log` — the MCP-transport attempt that exposed the
   two subtleties this leg needed: (a) pi-lens's scanner caches are PER-CWD
   and macOS-symlink-sensitive (`/tmp/p05-legs` → `~/.pi-lens/projects/tmp-p05-legs/`,
   `/private/tmp/p05-legs` → `…private-tmp-p05-legs/` — watching the wrong
   sibling reads as "no cache"); (b) a turn-end that races the first-ever
   trivy scan misses it.
5. `leg-b5-mcp-trivy-stop-OBSERVED.log` — **the trivy→sessionSecrets→🔴 STOP
   promotion OBSERVED live** over MCP stdio, no fakes, with the trivy gate
   open (`trivy.enabled` + manifest + classic-typescript host fixes):
   session-start ran trivy (127 ms scan), the cache carried
   `slack-access-token @ slack-fixture.ts:1`, and `pilens_turn_end` promoted:

   ```
   🔴 STOP — hardcoded secrets detected. Rotate the credentials and remove them from source:
     slack-fixture.ts:1 — slack-access-token [trivy]: Slack token
   ```

6. `leg-b-session-start-attempt.jsonl` — the default json/rpc agent-session
   evidence. SCOPED CORRECTION (CR round 1, finding 2): the earlier claim
   "heavyweight scans never run in headless sessions" was OVERCLAIMED — the
   8 default json/rpc sessions only prove DEFAULT sessions skip them; the MCP
   stdio transport AUTO-RUNS the full session_start lifecycle on server boot
   (`dist/mcp/server.js` auto `runSessionStart`), which is exactly how leg b5
   closed the chain. Default json/rpc agent sessions still show no
   heavyweight-scan caches and still read the trivy cache only if something
   else populated it — that narrower statement stands.

**Net:** NFR-SEC-3's emit-block is now PROVEN live end-to-end: detection
(opengrep in the verify run; trivy slack-rule), cache, promotion, and the 🔴
STOP reaching the consumer — the secrets blocker with `[trivy]` provenance was
observed verbatim over MCP stdio (leg b5) and a blocker reached a real agent
over `--mode json` (leg b1). The verify harness's optional probe still records
its own stricter bar (`emitBlockObserved:false` for its specific turn-end
probe shape); that probe's non-observation predates this leg and describes
that probe, not the promotion.

## Fixture notes

- All secrets in fixtures are synthetic (runtime-generated shapes; the AKIA
  string is a distorted-EXAMPLE literal, the xoxb/github_pat strings are
  doc-format placeholders). No real credential ever existed in these files.
- The fixture `.pi-lens.json` (`trivy.enabled: true`) + `package.json` were
  required to open pi-lens's trivy gate — measured: `isTrivyEnabled` returned
  false until both existed.
- pi-lens's managed `~/.pi-lens/tools` typescript was 7.0.2 (native-only, no
  `lib/tsserver.js`), which killed typescript-language-server at spawn; a
  classic typescript@5.8.3 seeded into `~/.pi-lens/tools/node_modules` (and a
  global npm classic typescript) restored LSP diagnostics. Recorded here
  because it is host-state, not repo-state.
