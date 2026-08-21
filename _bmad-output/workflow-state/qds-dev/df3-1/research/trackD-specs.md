# Track D — Spec constraints (done 2026-08-21)
- Tier-1 = tested fleet-dispatcher CLI, operator is channel (DD-1: no Telegram); agent never composes provider commands
- DD-7: SwarmClaw dormant chassis, NOT front door
- §5.3/requestId: strict UUID v4, four propagation sites, join key for cross-layer tracing; envelope-id rules N/A (P1.1 chain dead) — re-aimed: tier1 dispatch -> fleet dispatcher -> in-box subprocess -> phase-engine step
- ExitStatus: import from cli-anything/src/types.ts, never re-declare; 5 values success|transient|overflow|logic|lead_failure; unknown -> treat as transient
- Retry: single owner at dispatch boundary, provider calls only, callers MUST NOT nest; ceiling timeoutMs*3+3s
- Boundaries: DF1.8 owns resolver; DF2.6/DF2.8 outbound calls from tier-1; DF3.2 admitted:true after cap+quota pass
- µ$ integers everywhere; default cap 5,000,000 µ$ ($5.00) per DF2.8 (NOTE: credentials.ts defaultKeyCapMicroUsd=50_000_000 = $50 — DF2.8 default differs; dispatch uses DF2.8-side default via assertWithinBudget + mintCapMicroUsd)
- Guards: brief 64KiB; 600s dispatch wall clock; 30s status list timeout -> boxUnknown
