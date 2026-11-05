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
transport. (AC1's aw:<hash> id clause is covered by the verify harness's
observed-id probe — aw: ids are turn-end aggregations, not per-tool-result
fields; they are not present in these logs and the logs do not claim them.)

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

## Leg b — secret-scan emit-block (NFR-SEC-3 + INV-1): PARTIAL, precisely diagnosed

Four logs document the chain. What each proves:

1. `leg-b-ts-error-stop-block.jsonl` — **the block mechanism is observed live**:
   a 🔴 STOP turn-end blocker (TS2322 redeclare) reached the agent in a real
   `--mode json` session; the agent received and narrated it ("The pi-lens
   notice about variable redeclaration..."). The promotion+delivery path works
   end-to-end.
2. `leg-b-rpc-model-refusal.jsonl` — the agent (claude-haiku-4-5) REFUSED to
   write a slack-token-shaped literal even as a declared test fixture ("I'm not
   going to write that file as-is... credential-in-source-control issue"). A
   secrets-blocker leg needs the agent to emit a trivy-detectable secret.
3. `trivy-db-warmup.log` + direct-CLI runs — trivy 0.76.1 secret detection is
   live (slack-access-token HIGH fired on a synthetic token file), but its
   ruleset no longer contains the generic AWS access-key rule (`AKIA…` shapes
   do not fire; only maven/slack-family rules matched in debug output), and
   pi-lens's own `TrivyClient.scan()` runs it clean end-to-end once the
   `trivy.enabled` + dependency-manifest gate is satisfied.
4. `leg-b-session-start-attempt.jsonl` — the structural gap: pi-lens 3.8.71's
   session-start heavyweight scans (gitleaks/jscpd/madge/trivy) **never run in
   headless or rpc sessions**. Measured across 8 headless/rpc sessions:
   `~/.pi-lens/projects/<proj>/cache/` gained knip caches only — zero
   gitleaks/jscpd/madge/trivy caches; `sessionstart.log` shows auto-install
   ensure lines only. Turn-end reads the trivy cache
   (`runtime-turn.js:377-389`, source-verified), so with no cache ever written,
   the trivy→sessionSecrets→🔴 STOP promotion is unreachable in headless mode.

**Net:** block mechanism proven live (via the TS-error STOP), secret DETECTION
proven live (opengrep in the verify run; trivy slack-rule via direct CLI), but
the specific trivy→secrets-STOP promotion was not observed and is structurally
unreachable headless on pi-lens 3.8.71 + pi 1.1.0. Closing it needs either an
interactive session leg or a pi-lens-side session-start-in-headless fix —
both operator calls. The verify harness's own optional probe reaches the same
wall (blockMechanism source-verified, emitBlockObserved false).

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
