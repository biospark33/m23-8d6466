# Track F — Consumer Contracts (done 2026-08-21)
- DF3.2: dispatch(brief,{admitted:true,runId}) + exported mintRunId() + one checkHeadroom(N); .sandbox/fleet.lock O_EXCL 0600 (DF3.2-owned)
- DF3.3: brief arrives w/ requestId intact; consumes closed brief-schema.ts
- DF3.4: adds approve/reject/attach registry entries to DF3.1's verbs.ts; extends DF3.1's status.ts
- DF3.5: listVerbs() sole source; contract test parses SKILL.md fenced fleet commands against registry
- DF3.6: limitMicroUsd read ONLY from frozen manifest; missing => refuse run
- Verdict: all compatible, zero conflicts with DF3.1 spec
