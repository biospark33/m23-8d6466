# A6 round-1 review — edge-case-hunter report

Reviewer: edge-case-hunter subagent (read-only, no authoring context).
Scope: `git diff dev...HEAD` = c9d03b51 (wrapper, leaf, crontab.factory, two suites) + 625e27c6 (SKILL.md chore).
Method: environmental and boundary hunting — cron portability, test determinism, fd inheritance, guard symmetry, emit-path robustness.

## Findings

- **EH-001 · MED · deploy/vps/crontab.factory:9-10** — crontab.factory ships no `PATH`; Debian cron PATH=`/usr/bin:/bin` excludes bun's install locations, so every tick exit-3s pre-cycle. Separately, `/var/log/qds` may not exist, and a failed redirect kills the entry before the wrapper runs — the entire observable output silently absent.
  Fix: wrapper gains documented bun-location fallback resolution (`command -v bun` → `$HOME/.bun/bin`, `/usr/local/bin`, `$HOME/.local/bin` → export PATH) mirroring the canonical script's gitnexus fallback idiom; crontab header comment names the PATH prerequisite and the one-time operator creation of `/var/log/qds`; suite source-pin asserts the fallback lines exist.

- **EH-002 · MED · tests/gitnexus/refresh-cron.test.ts:756,763-771,800-803** — both AC5 lock fixtures synchronize via a fixed 2 s sleep inside the holder while tick B must complete bash boot + `git rev-parse` + bun staleness spawn inside that window — under CI load B arrives after release and the coalesce proof flakes.
  Fix: determinize — holder holds ≥30 s; B's skip line is polled with a bounded wait; the holder is killed (SIGTERM) only after B's refusal is observed; no fixed sleep gates any assertion.

- **EH-003 · LOW · scripts/gitnexus-refresh.sh:308-318,332,344** — `exec 9>>` without close-on-exec: reindex/contract children inherit fd 9 sharing the open-file description — a selective wrapper kill leaves the lock held by an orphaned cycle that never writes its line; the header's "kernel releases on ANY exit" claim is inaccurate while children live.
  Fix: invoke both children with `9>&-` so the lock's only holder is the wrapper itself and the header claim becomes true; header comment updated; suite source-pin asserts the redirection on both invocation lines.

- **EH-004 · LOW · scripts/gitnexus-refresh.sh:155-175** — set-but-empty `QDS_REFRESH_LOG` keeps `:-` semantics — a fixture run computing an empty log override silently aims the cycle's record at the LIVE sink; guard asymmetry vs the command overrides.
  Fix: extend the set-but-empty guard family to `QDS_REFRESH_LOG` (FATAL exit 3, no cycle) + fixture test; `QDS_GITNEXUS_HOME` keeps F-017 set-but-empty-as-unset semantics (safe: the fixture reindex refuses an unset home by name).

- **EH-005 · LOW · scripts/gitnexus-refresh.sh:262-276** — the emit path's `date` leg is bare under `set -e` — a transient date(1) failure aborts emit after reindex+contract succeeded, losing the record the adjacent code explicitly hardened the clock for.
  Fix: harden `now=$(date ... || true)`; if empty fall back to `$CYCLE` (tick-start UTC — skew beats a lost record); comment explains the degradation.

- **EH-006 · LOW · scripts/gitnexus-refresh.sh:286-288** — stampPath control characters (TAB/CR) pass the sed `[^"]*` extractor and land raw inside the JSON line — parseCycleLine rejects unescaped control chars, poisoning the whole cycle record.
  Fix: same fix as BH-001 (`json_escape` drops `\000`-`\037` control chars).

## Round 2 (2026-10-13, scope: fix commit 12941273)

EH2-001 · MED — split-brain guard bypass via the override-shaped door (canonical writer spelled as the override); EH2-002 · LOW — set -u unbound-variable death in the probe (= BH2-001); EH2-003 · LOW — stripped-PATH test's unconditional assertions on the conceded every-prereq host. Verified clean: guard vs F-017, 9>&- vs fixture commands, exit-1 sink path vs contract, handshake timing bounds, chmod restore windows. Full dispositions: round-2-triage.json.

## Round 3 (2026-10-13, scope: fix commit d4b92f9d — round-2 diff)

Verdict: **CLEAN** — no findings. The round-2 patches re-probed for the round-1 regression classes (cron portability, test determinism, fd inheritance, guard symmetry, emit robustness) and the environmental matrix gained two new named-skip host conditions verified consistent: `STRIPPED_PATH_HOST_PASSES_EVERYTHING` guards both stripped-env tests symmetrically after the round-3 BH3-001 patch, and the behavioral bun-probe rescue test's `skipIf(!existsSync("/usr/bin/flock"))` matches the AA2-007 rationale (runs on Linux CI, named skip on macOS dev).
