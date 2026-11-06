# p0-9 closure evidence — reading notes

The JSON files in this folder are kept exactly as the leg drivers wrote them on qds-alpha (2026-10-04). They are not edited after capture. Where a driver's own classification is wrong, the correction is recorded here and fixed in the driver, never in the evidence.

## auth-retired-check (`…-auth-retired-check-tb6g2k.json`)

The `knownKeyOutOfScope` and `unknownKey` probes both got **HTTP 410**. Their response tails show that the bank-profile endpoint was removed in Hindsight 0.10.0, so the request never reached a credential check. The driver labels them `known-key-out-of-scope-http_410` and `unknown-key-refused-http_410`, and those labels are wrong. Read both probes as **inconclusive for authorization**. They prove nothing about credential refusal.

What the file does establish:

- `unauthenticated` answered 200 on retain and recall. The instance accepts unauthenticated writes, so `dangerRetired=false` stands.
- `keyProof` answered 200.

The driver fix (probe a supported endpoint and treat a 410 as inconclusive) belongs to work item 2, the schemas.ts conformance amendment tracked in issue #408. The same 410 misreading affects the negative control in `…-negative-probes-pisa2e.json`.

## document-id-retain-twice (`…-document-id-retain-twice.json`)

The record sets `upsertObserved: true`, which overstates what was measured. Both retains sent the same `document_id` with **identical content**. The second retain used 0 tokens, and the document and node counts stayed at 1. That shows an identical re-retain is a no-op that creates no duplicate. It does not show that a retain with **changed** content updates the existing document. Read this record as a **no-duplicate check**. Proving the update path needs a second retain with different content and a read-back. That probe belongs to work item 2.

## negative-probes (`…-negative-probes-pisa2e.json`)

Two of the recorded refusals are mislabelled:

- `recall-missing-bank` is recorded as `http_502`, but the recorded detail proves the client logged a successful 2xx response: `requestJSON` in `src/hindsight/client.ts` only reaches `RecallResponseSchema` validation after a 2xx, and it rethrew that local validation failure (`durationMs` missing) as `HindsightHttpError(502, …)`. The saved artifacts record neither the upstream status nor the recall body — HTTP 200 with empty results is an inference, not an observation. Read it as **local schema validation**. It is not a server refusal. It is the same 0.10.0 response drift that fails round-trip.
- `missing-bank-profile-read` (`http_410`) hit the removed bank-profile endpoint, like the auth-retired probes above. It is inconclusive.

Fixing the driver (a separate classification for schema-validation failures and a supported endpoint for the profile probe) belongs to work item 2 in issue #408.

## Redaction note (2026-10-07)

On 2026-10-07, every occurrence of a revoked OpenRouter key id inside the account-management URLs of `2026-10-07T11-49-36-792Z-p0-9-provision-and-import-vrf9ks.json` (64 occurrences) was replaced with `<revoked-key-id-redacted>`. The keys were revoked before redaction; the ids are account-identifying management-URL material, so they were scrubbed for secret hygiene. No other bytes in the evidence were altered — this is the sole sanctioned deviation from the "never edited after capture" rule above.

## 2026-11-05 window (qds-alpha, recreated instance)

The instance was RECREATED since the 2026-10-04 window: new address `149.28.248.96` (the register's `207.148.6.90` is dead), new host key `SHA256:+1OxgL16LT6TuOgjvgMBeE6BOKao1jO70U9kTPzFgDE` (plan §1's `Mi6otoaTO…` is stale for the new instance), solstice stack re-provisioned ~3 weeks prior. `solstice_fleet` key restored from Proton Pass "Operating" (fingerprint-verified against plan §1). All six 2026-11-05 files were captured on the recreated box through the bastion chain, legs run from `/opt/qds/QDS-Factory` @ `4d447bb6` (dev), `QDS_FORK_CHECKOUT=/opt/qds/solstice-ai`, hindsight-qds deployed from the repo's `deploy/vps/docker-compose.factory.yml` (fresh volumes, banks roster empty at start — the foreign-same-id check), AC6 holds (18890 loopback-only, external probe refuses).

Reading notes:

- `…-hindsight-live-wq5na2/dn68yz` (ok=false): two setup failures before the green run — `failed-fork-checkout-unset`, then `failed-docker-inspect` (compose project named the container `vps-hindsight-qds-1`; the leg's default lookup name is `hindsight-qds`). Fixed by env (`QDS_FORK_CHECKOUT` + `QDS_HINDSIGHT_CONTAINER` in the checkout `.env`), not by editing evidence. The third file `…-hindsight-live-t6ll11` (ok=true): health ok, digest-identity ok (fork pin `3edcb616…` == running image), live retain+recall answered, probe bank deleted. The shape prereq for the remaining legs is stamped.
- `…-round-trip-via-bridge-5d934h` (ok=false): **reflect drift, real** — failed at step reflect: the client's `ReflectResponseSchema` (still the legacy `bankId/insights[]/durationMs` shape — the #408 conformance amendment never covered reflect) refused the 0.10.0 reflect response (`bankId` undefined), rethrown as `bad_gateway`. The verbatim zod error is in the evidence. This is the conformance remainder's third missing slice; fix = adapter-in-schema for reflect like retain/recall/consolidate got, measurement-gated on THIS raw response, which the evidence carries.
- `…-negative-probes-51ve91` (ok=true): both refusal proofs landed on the CONFORMANT drivers (#499): operations-read 404 (missing-bank-operations-read) + transport refusal on the down target; zero banks created.
- `…-idempotency-rerun-skmtfv` (ok=true): provisioner rerun created nothing new; zero-banks diff clean.
- provision-and-import: NO evidence file — the leg was killed by the 600s alarm (exit 142) mid-run amid **OpenRouter 402** (`limit_source: openrouter_credits` — the workspace credit pool, not the key's $50 limit; solstice-hindsight usage $1.14/50 recorded before the pool floor). Retains need the workspace topped up; the leg rerun rides the next window. auth-retired-check + changed-content-upsert also hold for credits.

### Continuation (same day, ~19:11Z — pool refilled only to a token floor)

A 1-token probe answered 200 and was read as "credits restored" — wrong: the pool had only enough credit to collateralize ~63,743 tokens, and the extraction path requests `max_tokens 64000`, so retains still 402. The three held legs ran anyway (window discipline: run and record):

- `…-provision-and-import-s4c2fb` (ok=false): provisioning GREEN (5 roster banks reupserted, snapshot 5→5), first mulch-import retained 23 expertise entries before the pool floor bit; subsequent batches 402'd, leg-failure recorded honestly. Rerun is rerun-safe (idempotency leg proves the provisioner).
- `…-auth-retired-check-8tfhbg` (ok=true): all three probes measured, classes exactly as the #499 drivers predict on real 0.10.0: unauthenticated retain answered 2xx (the 0.8.6 danger is NOT retired on this instance — the record carries it), knownKeyOutOfScope = `not-applicable-authz-absent` (Track A, live), unknownKey answered (`unknown-key-answered`). dangerRetired=false honest. First live validation of the conformant drivers.
- `…-changed-content-upsert-04ya9t` (ok=true, `upsertObserved=false` honest): retain v1 402'd (`Fact extraction failed … 402`, wrapped HTTP 500), so v2/baseline/read-back skipped; probe bank cleanup `already-gone` (the lazy-create never landed). The leg records the unmeasured shape without claiming an update — exactly the honest-unmeasured arm working.

Pool floor ≈ 63,743-token collateral at capture time. Reruns of provision-and-import + changed-content-upsert + the reflect capture ride the next real top-up.

### 2026-11-06 window (funded rerun — workspace key swapped)

The `solstice-hindsight` key's workspace (`default`, org `org_3JBs…`) had $10.00 purchased / $9.77 used / **$0.23 spendable** — even a single reflect call 402'd (refused at `requested up to 65536 tokens, but can only afford 61475`). A funded key from the operator's main OpenRouter account was swapped into `/opt/qds/QDS-Factory/deploy/vps/hindsight-qds.env` (env, not evidence; container recreated) and the held legs reran green:

- `…-reflect-raw-body-fisr9` (curl capture, HTTP 200): the raw 0.10.0 reflect body the client refused on 2026-11-05. Required field = **`text` only** (markdown); `based_on`/`structured_output`/`structured_output_error`/`usage`/`trace` all null on this capture. This is the measurement the reflect conformance slice (schemas.ts `ReflectResponseSchema`, the #408 remainder's third missing slice) is gated on.
- `…-provision-and-import-nsbwyo` (ok=true, live): full leg green on the funded key — 5 roster banks reupserted (snapshot 5→5), mulch-import completed (qds-collective among the ok steps). Closes the 2026-11-05 pool-floor failure arm.
- `…-changed-content-upsert-cbiimm` (ok=true, **`upsertObserved=true`**): the update path finally measured — retain v1 → recall baseline (v1 only) → retain v2 CHANGED content → read-back shows v2, v1 gone → cleanup deleted. Closes the `document-id-retain-twice` correction note above (no-duplicate was proven 2026-10-04; changed-content update was the unmeasured half).
