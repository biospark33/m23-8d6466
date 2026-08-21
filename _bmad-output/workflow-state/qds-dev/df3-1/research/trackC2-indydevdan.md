# Track C2 — IndyDevDan reference repos (direct scan 2026-08-21; agent report lost, rescanned by orchestrator)
Repos (both MIT, Copyright (c) 2026 IndyDevDan):
1. super-simple-software-factory — Python ADW skill (.claude/skills/sssf/). Doctrine: control plane in code, agents bounded nodes, typed JSON envelopes, SQLite trace. NO TS, no dispatcher code to lift verbatim.
2. inkwell-agent-sandboxes-and-software-factory — same ADW pattern + sandbox_mount/{host,guest} + ai_docs/exedev_sandbox_mounting.md (629 ln, live-verified 2026-08-04: exe.dev API IS SSH, control plane ssh exe.dev <verb> --json, data plane ssh <vm>.exe.xyz; POST /exec caps 30s/64KB).

LIFT FINDINGS:
- sandbox_mount/host/run_record.py (273 ln) IS THE ANCESTOR of our src/providers/run-record.ts (DF2.1): same 12 fields, same <slug>-YYYYMMDD-6hex new_run_id, same O_EXCL refuse-to-clobber, same .sandbox/runs/. Our TS version is the hardened descendant (path-traversal/symlink fixes). DO NOT re-port from Python — reuse DF2.1.
- sandbox_mount/host/runs_table.py (52 ln): three-state status doctrine — vm_state "up"/"gone"/"?" where unknown-vs-gone distinction is deliberate ("a failed lookup must never render as every VM is destroyed"). Maps 1:1 to DF3.1 AC4 live/boxMissing/boxUnknown. LIFT THE DOCTRINE into status.ts (TS rendering authored fresh, table shape similar: RUN/STATE/VM/SPEND/CREATED).
- guest/provision.sh: box-side provisioning — DF2.2 territory, already implemented.
- exedev_sandbox_mounting.md: keep as [VERIFY] reference for any exedev behavior questions; not needed for dispatch against fake driver.

PONYTAIL VERDICT: direct verbatim TS lifting from these repos NOT applicable (Python). Maximum-reuse path = compose QDS-Factory's own tested DF2.x layer (createRun/teardownSandbox/harvestRun/checkHeadroom/assertWithinBudget/resolveRunCorrelation/newId/cli-args/log) which already descends from these repos' patterns. New code = only the story-mandated net-new surface: brief-schema, verbs registry, dispatch/status composition, scripts/fleet.ts, manifest limitMicroUsd field, tests.

## FULL AGENT REPORT (arrived late, supersedes scan summary where richer)
- inkwell also contains .claude/skills/sandbox-exe-dev/exedev_cli/ (Python Click CLI: init/doctor/vm list/vm kill, ssh_runner control_plane -> JSON). Production-grade. Click verb pattern = doctrine only; our CLI uses repo's own scripts/lib/cli-args.ts TS precedent instead.
- Brief schema: NOT present in either repo — build fresh with zod (confirms DD-8 NET-NEW).
- Dispatch ordering record->box->key present as `just sbx lifecycle create` shell recipe; teardown ordering spend->harvest->revoke->kill->close as shell recipe. Lift ORDER (our TS layer already encodes it: createRun/teardownSandbox).
- MIT both repos (c) 2026 IndyDevDan. Attribution template for any substantially lifted code:
  /* Based on code from indydevdan/inkwell-agent-sandboxes-and-software-factory
     Copyright (c) 2026 IndyDevDan — MIT License. Adapted for QDS-Factory DF3.1. */
  Use on status.ts (runs_table three-state doctrine) — the one place doctrine is copied.
- C2's suggested exit-code table CONFLICTS with story's table — story wins (0 ok/1 fail/2 schema/3 gate/4 not-found/5 refused).
