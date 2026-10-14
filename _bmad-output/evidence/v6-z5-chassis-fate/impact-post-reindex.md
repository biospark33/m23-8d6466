# Z5 post-reindex GitNexus impact evidence (2026-10-13)

Index state: reindexed this session via `bash scripts/install-gitnexus-plus.sh`
(install b686alvie exit 0; analyze delta "0 changed, 1 added" ⇒ graph was current,
only the stamp was stale). `.gitnexus/cli-version.json` indexedHead = e9321a6c = HEAD.
MCP tools may still print a cached "45 commits behind" hint — in-process cached stamp;
the on-disk stamp + analyze delta are the proven artifacts (cite this file, treat the
hint as an artifact).

## impact(log) — disambiguated via file_path src/swarmclaw/log.ts (bare name = 92 candidates)
- risk CRITICAL (headline) / CRITICAL (shared axes); epistemic **exact**
- 341 impacted symbols total, **127 direct** (byDepth 127 / 129 / 85)
- 82 affected processes; top flows: fetch, observeSweep, runDestructive,
  runMemoryKeyLifecycle, reapRuns
- 19 affected modules; top: Fleet 112, Providers 71, Scripts 46
- Pre-reindex payload retained: impact-log-full.txt (325 impacted, 122 direct)

## impact(setLogSink) — disambiguated via file_path
- 15 impacted (12 direct); MEDIUM / MEDIUM; exact

## impact(maskEnv) — disambiguated via file_path src/swarmclaw/mcp/tool-bridge.ts
- 19 impacted (2 direct = src/hindsight/client.ts + src/swarmclaw/routes/mcp-servers.ts —
  matches the grep census exactly); HIGH headline / LOW shared-axes; exact

## Reading for the plan
- `log` CRITICAL confirms the chassis move is a fleet-wide import rewrite: the
  blast radius is breadth-of-consumers, not behavior (byte-identical bodies pinned
  by verbatim/block oracles; diff-shape pins every changed line to import lines).
- Direct-caller counts match the grep-derived inventory (direct-log-importers 88:
  src 31 / scripts 12 / tests 45 — plus re-export indirection), so the wave topology
  was sized off proven numbers, not estimates.
- maskEnv: exactly 2 direct importers, both rewritten in leaf-1.1.1 (client.ts is
  leaf-1.1.3's file but its maskEnv edge is severed by the 1.1.1 import re-point? No —
  client.ts:26 is leaf-1.1.3's own line; 1.1.1 owns tool-bridge severing, 1.1.3 owns
  the client.ts re-point. The 2 direct hits split across those two leaves by file
  ownership.)
