# TEST-DESIGN BRIEF — T3 candidates: many-stories live + expose/port live

Repo /Users/steve/QDS-Factory @ `feature/df3-2-fanout-best-of-n`. All paths repo-relative. Read-only recon; nothing was edited.

## 1. MANY-STORIES: TRACE

Validation, exit 2 pre-lock, zero side effects — `validatePatternInput` src/fleet/fanout-primitive.ts:161:

- Pattern whitelist :162-164. minN: many-stories=1, others=2 (:165); n bounded 1..FANOUT_MAX_N=8 (:166-173; const :48).
- many-stories requires an ARRAY of briefs with length === n exactly (:174-180, "brief-count-mismatch").
- rosterIds FORBIDDEN (:181-183, "roster-forbidden"). best-of-n/race: array REJECTED — one brief object only (:184-186); roster REQUIRED with length === n (:199-209).
- briefList: many-stories keeps the per-arm parsed list; best-of-n/race expand the one brief ×n (:187-198) so per-arm indexing is uniform downstream.
- `assertFanoutPin` :235-244: many-stories + --pin → exit 2 "pin-mismatch" outright (:237-239); others require pin === briefs[0].commitSha (:240-243). CLI calls it at scripts/fleet.ts:1643-1644 after the known-pattern guard :1586-1599.

Record/mint/dispatch differences vs best-of-n:

- Record pin = null for many-stories (:350); arms attach rosterId ONLY when input.rosterIds defined (:370-374) → many-stories FanoutRecord arms carry briefHash but NO rosterId. Per-arm briefHash = sha256(JSON.stringify(briefList[i])) (:374), distinct iff brief JSON differs.
- Everything upstream identical to best-of-n: ONE checkHeadroom(n) in-lock (:265-300); store.create O_EXCL (:348-362); synchronous n×mintRunId (:364-367); INV-3 admitted line aggregateExposure=n×cap (:381-392); semaphore(min(n,headroom,8)) allSettled (:401-403); per-arm dispatch(briefList[i], armDeps, {admitted:true, runId}) (:488) with fresh armDeps (:472-486).
- No poller/winner/disposal outside race (:406-413) — winner always null. Auto-rank is best-of-n-only (scripts/fleet.ts:1734) → many-stories stdout is EXACTLY the 2 arm JSON lines (:1714-1724).
- CC-9: many-stories briefs share no requestId so the invocation mints THE one id (scripts/fleet.ts:1618-1637); briefs arrive wrapped {"briefs":[…]} (:1618-1628). CLI mirrors roster-forbidden BEFORE wrapper-validity (:1577-1585); "--roster ''" = flag-absent semantics (:1570-1573).

Can two distinct briefs share one issueId? YES — nothing forbids it (BriefSchema src/fleet/brief-schema.ts:289-427 has no cross-brief rule; validatePatternInput checks count only). Same repoSlug#issueId with different commitSha/manifestPath is legal.

## 2. F15 BUG (confirmed by reading)

Block src/fleet/fanout-primitive.ts:302-344 reads ONLY briefList[0]: brief0=:315; issueKey=`${brief0.repoSlug}#${brief0.issueId}` :317; issueBudgetSnapshot for THAT issue only :322-327; need = n×cap :334; refuse "issue-ceiling-insufficient" :335-343.

Ledger budgets PER ISSUE: issueBudgetSnapshot(repoSlug, issueId) src/providers/cost-ledger.ts:1221; admitIssue :1264; ceiling resolution via defaultCapMicroUsd/perIssueOverrides :516-585.

When many-stories briefs have DIFFERENT issueIds this is wrong twice:

- **(a) OVER-REFUSAL**: demands n×cap headroom on arm 0's issue though arm 0 bills only cap against it → a legitimate 2-arm/2-issue fan-out refuses exit 5 before anything minted.
- **(b) UNDER-PROTECTION** (the exact hazard the block's own comment :303-313 names): arms 1..n-1's issues are NEVER checked; their admitIssue refusals land budget-exceeded MID-allSettled — after mints and possibly after arm 0 provisioned a billable box → deterministic partial fan-out.

Remediation names only brief0's issueKey override (:340). Correct shape: group briefList by (repoSlug, issueId), require Σ(groupCount × cap) per group. Flag for a fix track; recon only here.

## 3. MANY-STORIES LIVE E2E DESIGN

Model on tests/fleet/e2e/tier2-fanout-bestofn.live.test.ts + harness tests/fleet/e2e/live-harness.ts (liveGate("2"), runFleet subprocess, writeEvidence secret-scrub, destroyQuietly finally). NO FAKES rule stands (harness header :1-22).

**Roster interplay**: --roster forbidden does NOT mean no roster — each arm's setup gate reads roster.yaml beside ITS OWN brief.manifestPath: dispatch.ts:1407-1422 ("roster-missing" refusal; exedev driver + non-injected gate only :1413), charset guard :1432-1440, parse :1447-1522; the gate pings every distinct slug (src/providers/exedev/setup-gate.ts:147-163). Per-arm model variation = give each brief its own manifestPath (+ roster.yaml beside it). One shared manifestPath is also valid (same roster both arms).

**Happy path**: BOTH briefs share biospark33/QDS-Factory#46 (F15 stays CORRECT for one issue) → cost-config perIssueOverrides {"biospark33/QDS-Factory#46": 100000}, exactly T2.2:95-102. Distinct issues belong to the F15 probes below.

Command:

```
bun scripts/fleet.ts fanout --pattern many-stories --n 2 --brief briefs.json \
  --cap-micro-usd 50000 --driver exedev --dir <fanouts>   # env QDS_RUNS_DIR=<runs>
# NO --roster, NO --pin
```

Assertions:

- exit 0; 2 arm lines outcome=ready, distinct runIds, fanoutId /^fan-/;
- record pattern="many-stories", pin===null, arms have briefHash and NO rosterId key, the two briefHashes DIFFER (recompute sha256 of JSON.stringify(brief) in-test, :374 contract);
- both vms live via driver.list;
- per-arm run records limitMicroUsd=50000 + commitSha from its own brief (dispatch stamps :2460-2468);
- harvest+teardown BOTH arms (both stories are the artifact — T2.2 header reasoning :15-22);
- NO auto-rank/scores line in stdout (:1734 gating).

Zero-spend negative probes (all pre-construction): `--roster` → exit 2 roster-forbidden (fleet.ts:1580-1585); `--pin` → exit 2 pin-mismatch (:1644→primitive :237); briefs.length≠n → brief-count-mismatch (:178); n=1 legal for many-stories (:165).

F15 live probes:

- **P1 over-refusal, $0**: two briefs DIFFERENT issueIds A,B; cost-config overrides ONLY {"…#A": 50000}. Expect exit 5 issue-ceiling-insufficient naming repo#A, needMicroUsd=100000, availableMicroUsd=50000 — proving over-refusal (arm 0 needs only 50000). Refuses pre-mint (:334-343) → zero spend.
- **P2 under-protection, COSTED, optional**: overrides {"…#A": 100000, "…#B": 10000}. Pre-flight passes on A's numbers; arm 1 refused budget-exceeded mid-flight while arm 0 provisions → partial fan-out with a live billable box. Cost ≈ 1 key + 1 box.

## 4. EXPOSE/PORT: TRACE

Route: --port declared on DISPATCH ONLY (src/fleet/verbs.ts:59-60 — "the only route to DispatchDeps.port"); fanout has NO --port flag AND FleetDeps omits port (scripts/fleet.ts:225-226) — the fanout CLI cannot expose even though FanoutDeps inherits port and runArms forwards it to every arm (fanout-primitive.ts:479). Live expose test MUST use the dispatch verb.

CLI parse scripts/fleet.ts:1332-1349 (plain-decimal regex, range 1..65535), threaded into deps at :1423; dispatch() re-validates exit 2 "port-invalid" (src/fleet/dispatch.ts:1156-1163).

Provisioning deliberately does NOT expose: port withheld from provisionAdmittedRun (dispatch.ts:1899-1913, comment :1901-1904 — INV-5 forbids tearing down a box made public before the gate proved it). Default httpsUrl therefore comes from create-time vm.httpsUrl (ctxHttpsUrl = vm.httpsUrl, dispatch.ts:2049) — matches every TIER-2 ack showing driver-default URLs.

Step 10 (post-gate) dispatch.ts:2469-2642, in order:

1. post-gate deadline sample (:2493, timedOut("post-gate",{gateReady:true}));
2. speculative ports claim written INSIDE the thunk BEFORE the provider call (:2522 deps.store.set(runId,{ports:[port]})) because within ABANDONS rather than cancels (:2516-2521; within impl :1045-1138 — race-and-abandon, no AbortSignal at the seam);
3. ctxHttpsUrl = await within("expose", … driver.expose(vm.name, port)) :2504-2541;
4. empty-URL refusal "expose-no-url" exit 1, box alive NOT public (:2561-2569);
5. httpsUrl persisted VERBATIM to record (:2570-2578 — persistent locator, deliberately unredacted);
6. within("setPublic") :2579-2586;
7. failure-path retraction rules :2608-2639 (phantom-port retract only while speculative; abandoned-timeout and post-resolve failures KEEP the claim).

Ack: state "ready", httpsUrl included when set (:2692-2698); structured log line redacts it (:2684); CLI writes the ack RAW including httpsUrl on purpose (scripts/fleet.ts:1440-1451).

What ExeDevDriver.expose DOES (src/providers/exedev/driver.ts:355-372): one control-plane call `ssh exe.dev share port <vm> <port>` (:360), then returns derivedUrl(vm) = `https://<name>.exe.xyz` (:122-125, :371). The URL carries NO port and is DERIVED (logged verified:"derived" :370); the share command's own output shape is [VERIFY] per the driver's comment (:368-369). setPublic (:379-407) = `share set-public <vm>` gated on host-side posture attestation .sandbox/exedev-posture.json vmSharing:"admins-only" (:109 default path; refusal BEFORE any share command :384-398).

**SECURITY CALLOUT**: a successful --port dispatch ends with the WHOLE BOX publicly reachable (set-public flips team sharing; the attestation exists because sharing defaults OPEN — driver.ts:374-378). There is NO un-share anywhere: grep shows only `share port` and `share set-public` are ever issued (driver.ts:360,:399); teardown.ts has ZERO share/port handling — retraction happens ONLY by destroying the VM (box destroy kills its shares). Between ack and teardown the URL is world-reachable with no auth.

Record/status surfaces: record `ports` is a registered extension field (src/providers/run-record.ts:68); status exposes safeUrl(httpsUrl) (src/fleet/status.ts:375).

## 5. EXPOSE LIVE E2E DESIGN

Model on tier2-dispatch-engine.live.test.ts. Preconditions: QDS_E2E_LIVE=1 + QDS_E2E_TIER=2(or 3), substrate env vars (live-harness.ts:41-46), AND .sandbox/exedev-posture.json recording vmSharing admins-only — without it dispatch fails at setPublic AFTER expose resolved (port claim retained, box alive not public, dispatch.ts:2579-2586 + driver :384-398): that is itself a valid cheap negative assertion.

Flow:

1. probe brief identical to T2.1/T2.2 shape;
2. `bun scripts/fleet.ts dispatch --driver exedev --brief b.json --port 8123` (uncommon port), isolated QDS_RUNS_DIR;
3. ack asserts: state==="ready", ack.httpsUrl === `https://<vmName>.exe.xyz` (derived form, no port suffix), vmName/runId present;
4. record asserts: ports===[8123], httpsUrl present verbatim, limitMicroUsd=cap;
5. reachability: driver.exec on-box to write a marker + serve (`python3 -m http.server 8123` / busybox httpd), then from HOST curl -m 10 https://\<vmName\>.exe.xyz/ expecting an HTTP response carrying the marker — no auth, this IS the public-internet proof; accept ANY HTTP response as pass and record bytes (exe.dev share routing is [VERIFY]; don't hard-pin 200);
6. teardown runId → closedAt set, box gone from ls, curl now FAILS (connection/DNS error) — that failure is the only "retract" assertion that exists since nothing calls an un-share;
7. finally: destroyQuietly fallback (harness :293-300) + final-ls empty sweep like T2.2:290-295.

Mitigations (mandatory in test docstring): unguessable box name via runIdFor (harness :113-120), serve ONLY a one-line marker file from tmp, keep ack→teardown window minutes-short, destroy in finally even on assertion failure, never serve anything with secrets, never reuse the box. Evidence may keep vmName/URL (identifiers, harness :17-21).

## 6. SPEND ESTIMATES (keys capped 50,000µ$, boxes 230,000µ$/h)

| Run | Model spend | Box spend | Worst case |
|---|---|---|---|
| Many-stories happy path N=2 | ≤100,000µ$ | worst ~230,000µ$ / realistic ~77,000µ$ (T2.2-shaped wall clock, outer timeout 30 min, T2.2:127) | ~$0.33 |
| P1 F15 over-refusal probe | $0 (refuses pre-mint) | $0 | $0 |
| P2 under-protection probe (optional) | ≤50,000µ$ | ≤~60,000µ$ | ≤~110,000µ$ |
| Expose e2e | ≤50,000µ$ | ≤~58,000µ$ (≤15 min incl. teardown) | ~$0.11 |

Approval lines: "2 keys × 50,000 + 2 boxes @ 230,000µ$/h" (many-stories) and "1 key × 50,000 + 1 box @ 230,000µ$/h" (expose). Combined session ask ≈ $0.45 worst case, ~$0.20 expected.
