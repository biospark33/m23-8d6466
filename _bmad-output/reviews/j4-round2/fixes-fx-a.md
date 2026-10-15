# FX-A fixes (J4 round 2)

- R2-15: `rejectionDetail` (steering.ts) strips host-only actions (`HOST_ONLY_ACTIONS`) from zod's discriminator enumeration. `{}` and `{"action":5}` now give the pre-J4 text (`... 'abort'`, no compact). KNOWN_ACTIONS unchanged. Test added in steering.test.ts.
- R2-04/R2-05: register item 16 (a) pin provenance (`285156f` stale, real dev `b34dc6b`, J4 `b34dc6b`->`348e5d4`) and (c) L7 makes zero asks in production today (resident block refreshed only after final.json); mid-run refresh unowned, rides arming PR.
- Gates: steering test 108 pass; biome clean; tsc clean. steering.ts moved the buildId; driver re-pins.
