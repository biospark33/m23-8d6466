# DF2.4 Evidence — Live Cap-Hit Kill Demonstration

**Verdict: `demonstrated`.** This is the discharge of audit §6 hole 6 (DD-6):
a real capped OpenRouter key on a real exe.dev box was spent to its ceiling,
the run was killed by the provider's cap, and every number the classification
rests on was read host-side from the provider — never out of the box. One
in-box figure exists — `turnsCompleted` (`turnsSource: "in-box"`), a
downgrade-only verdict gate (`0 turns → cap-below-first-turn`); see the AC1
table.

Run: `df2-4-cap-hit-20260819-fc8f12` · recorded 2026-08-19T06:57:00Z ·
branch `feature/df2-4-live-cap-hit-kill`.

## Artifact (verbatim, `.sandbox/evidence/df2-4-cap-hit-df2-4-cap-hit-20260819-fc8f12.json`)

```json
{
  "story": "df2-4",
  "runId": "df2-4-cap-hit-20260819-fc8f12",
  "requestId": "a59b5ac8-f6fe-4ff8-a8a9-aac8aa4e8a87",
  "substrate": "exedev",
  "capMicroUsd": 50000,
  "spendMicroUsd": 53447,
  "turnsCompleted": 25,
  "turnsSource": "in-box",
  "rejectionStatus": "403: {\"error\":{\"message\":\"Key limit exceeded (total limit). Manage it using [REDACTED]\",\"code\":403}}",
  "providerCapRejected": true,
  "terminationProvenance": null,
  "exitStatus": "overflow",
  "killOrigin": "provider-cap",
  "revocationVerified": true,
  "closedAt": "2026-08-19T06:57:00.814Z",
  "verdict": "demonstrated",
  "reason": null,
  "runBudgetCapMicros": 40000,
  "residentCeilingMicros": 30000,
  "keyHash": "e04ffb6c8731607617a7bd457c38d272bdb840fe7efdc5ba0e8c71651648f784",
  "timings": {
    "mint_ms": 501,
    "setup_ms": 29746,
    "workload_ms": 69044,
    "reprobe_ms": 172,
    "capture_spend_ms": 667,
    "teardown_ms": 6462
  },
  "recordedAt": "2026-08-19T06:57:00.816Z"
}
```

> Post-review note (2026-08-19): the verbatim 403 body's key-management URL
> (`openrouter.ai/.../keys/<hash>`) is redacted here and in the script's
> redaction pass. The key hash itself remains published deliberately — it is
> the artifact's `keyHash` identifier (not key material; the key was revoked
> and the revocation verified host-side).

## AC1 checklist, field by field

| AC1 clause | Evidence |
|---|---|
| workload killed on cap exhaustion | workload self-ended when the provider refused (25 paid turns, then the loop's 26th call got the refusal) |
| `spendMicroUsd ≥ capMicroUsd` | 53 447 ≥ 50 000 (µ$, host-side `captureSpend` from the provider's key entry) |
| `exitStatus: "overflow"` | classifier override (in-box signal was irrelevant — host evidence outranked it) |
| `killOrigin: "provider-cap"` | host re-probe observed the refusal |
| `revocationVerified: true` | teardown's list-absence proof after DELETE |
| closed run record | `closedAt` set; DF2.1 twelve-field schema untouched |
| `verdict: "demonstrated"` | all of the above |
| every number host-side | spend = provider list entry; cap = provider-echoed `limitMicroUsd`; revocation = key list; refusal = host re-probe. The box contributed exactly one figure — `turnsCompleted` (`turnsSource: "in-box"`), a downgrade-only gate: `0 turns → cap-below-first-turn`; it can never upgrade a verdict on truthful box output |
| no key material | artifact scanned: no `sk-or` substring, no `OPENROUTER_API_KEY=` line; only `keyHash` identifies the credential; no key-management URL (redacted, post-review) |

## Measured facts this live fire established (all 2026-08-19)

These were `[VERIFY]` items in the story; they are now measurements:

1. **The provider's key-limit rejection is HTTP 403** with body
   `{"error":{"message":"Key limit exceeded (total limit). …","code":403}}` —
   NOT the documented-for-account-credits 402 "Insufficient credits". The
   demo's probe accepts both signatures.
2. **Enforcement lags the crossing by ~2–4 requests / 15–30 s** (isolated with
   dedicated scratch keys: a $0.01 key first refused at $0.0178 ≈ 1.8×; this
   run crossed $0.05 and stopped at 53 447 µ$ ≈ +7%). The story's "[VERIFY]
   overshoot bounded by one request" is therefore optimistic for large
   requests: overshoot ≈ (lag ÷ request cadence) × request cost. Sizing turns
   at ~1 600 µ$ kept this run's overshoot to ~2 requests.
3. **`usage.cost` is route-dependent in shape** — `{"total": x}` on some
   upstreams, a bare float on others (GMICloud observed).
4. **pi's node streaming client stalls nondeterministically on exe.dev boxes**
   (fresh-box first calls and sustained loops; curl-based paths never stalled
   once across 19 runs). The workload and gate D are curl-based for this
   reason; pi remains in the box for the registry (B).
5. **The exe.dev image (`boldsoftware/exeuntu`) has no `/home/agent`** — the
   user is `exedev` (home `/home/exedev`), ships pi 0.84.2 with exe.dev's own
   provider integrations, and **no** `~/.pi/agent/models.json`. DF2.2/DF2.3's
   default paths assume the inkwell layout; the demo passes the corrected
   paths through their existing override knobs (env file `/home/exedev/.env`,
   workdir `/home/exedev/src`) and places a transformed cost catalog in-box
   before the gate.
6. **`pi -p` is single-turn** (a "count forever" prompt completes one turn and
   exits); the loopy shape must be a paid-until-refusal loop.

## Reproduce

```sh
bun scripts/cap-hit-demo.ts --driver exedev \
  --repo-url https://github.com/octocat/Hello-World.git \
  --sha 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d \
  --roster tests/providers/fixtures/df2-4-demo.roster.yaml \
  --cap 50000
```

Requires `OPENROUTER_PROVISIONING_KEY` in env or `.env` (bun auto-loads),
ssh access to exe.dev (`~/.ssh/config` entries for `exe.dev` / `*.exe.xyz`).
Costs one key at the cap plus the measured enforcement-lag overshoot; the
workload is ~35 two-second turns. The fill repo is any public repo at a
pinned SHA — the box never sees this (private) repo, and no git credential
ever enters it (INV-CRED-1). The roster above is the one the recorded run
used (`df2-4-demo.roster.yaml`, the single-model demo roster — a multi-model
roster would eat the cap in gate C pings before the workload ran).
