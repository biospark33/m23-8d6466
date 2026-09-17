/**
 * DF5.3 — the emit-side canonicalisation drift alarm.
 *
 * `src/providers/driver.ts` COPIES `canonicalJson`/`sha256Hex` rather than
 * importing them, because `src/providers/*` must not import `src/audit/*` (the
 * DF4.2 seam direction). The walker re-digests hops 4/5/6 with link-store's
 * canonicaliser, so any drift between the two copies reports
 * `evidence-mismatch` on every healthy link — permanently, on an append-only
 * store. THIS file is the alarm.
 *
 * It lives here and not in `driver-contract.test.ts`: that module is imported
 * by DF2.2 and the OCI driver suites, so a `describe` registered there runs the
 * alarm — and reports its failure — once per importing suite. This is a pure
 * unit test of the emit canonicaliser and needs no driver at all.
 */

import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "../../src/audit/link-store.ts";
import { emitAuditLink, type ProviderAuditLink } from "../../src/providers/driver.ts";

/** Capture the one link an emit produces. */
function emitted(detail?: unknown): ProviderAuditLink {
  let link: ProviderAuditLink | undefined;
  emitAuditLink((l) => {
    link = l;
  }, { runId: "r", repoSlug: "qds/demo", requestId: "req", hop: "run-box", event: "create", ...(detail === undefined ? {} : { detail }) });
  expect(link).toBeDefined();
  return link as ProviderAuditLink;
}

describe("DF5.3 — the emit digest is link-store's canonicalisation, byte for byte", () => {
  test("emitAuditLink's evidenceDigest === sha256Hex(canonicalJson(detail)) from the store module", () => {
    const detail = {
      limitMicroUsd: 50_000,
      z: { y: 1, a: undefined }, // undefined member drops; key order must not matter
      b: "second",
      arr: [3, 1, 2],
      nul: null,
    };
    const link = emitted(detail);
    expect(link.evidenceDigest).toBe(sha256Hex(canonicalJson(detail)));
    // One clock read: the event's own timestamp, both columns.
    expect(link.occurredAt).toBe(link.recordedAt);
    // Digest-only detail: `detail ?? null` — an absent detail digests "null".
    expect(emitted().evidenceDigest).toBe(sha256Hex(canonicalJson(null)));
  });

  // CONTRACT C1: both copies were changed this round to DROP `undefined` object
  // members and to never cast `JSON.stringify`'s `undefined` return. Agreement
  // on the happy path above is not enough — these are the three shapes where
  // the two implementations can disagree, and each is asserted against the
  // exact expected STRING as well as against link-store, so a matched drift in
  // BOTH copies still fails here.
  test("an undefined object member is DROPPED by both copies (C1)", () => {
    // `{a:1, b:undefined}` must digest identically to `{a:1}` — the store
    // persists the dropped form, so emitting `"b":null` is a false mismatch.
    expect(canonicalJson({ a: 1, b: undefined })).toBe(`{"a":1}`);
    expect(emitted({ a: 1, b: undefined }).evidenceDigest).toBe(sha256Hex(`{"a":1}`));
    expect(emitted({ a: 1, b: undefined }).evidenceDigest).toBe(emitted({ a: 1 }).evidenceDigest);
    // Nested, and every member undefined (the object survives as `{}`).
    expect(canonicalJson({ outer: { gone: undefined } })).toBe(`{"outer":{}}`);
    expect(emitted({ outer: { gone: undefined } }).evidenceDigest).toBe(sha256Hex(`{"outer":{}}`));
  });

  test("an undefined ARRAY ELEMENT still serialises as null in both copies (C1)", () => {
    // The drop rule is members-only. An array is positional: dropping an
    // element would renumber every element after it.
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
    expect(emitted([1, undefined, 3]).evidenceDigest).toBe(sha256Hex("[1,null,3]"));
    expect(emitted({ arr: [undefined] }).evidenceDigest).toBe(sha256Hex(`{"arr":[null]}`));
  });

  test("a non-JSON scalar canonicalises to \"null\", never to undefined (C1)", () => {
    // `JSON.stringify(() => {})` returns `undefined`, not a string. The old
    // `as string` cast let that reach the hasher as the literal "undefined".
    const fn = () => {};
    expect(canonicalJson(fn)).toBe("null");
    expect(canonicalJson(Symbol("s"))).toBe("null");
    expect(emitted(fn).evidenceDigest).toBe(sha256Hex("null"));
    expect(emitted(Symbol("s")).evidenceDigest).toBe(sha256Hex("null"));
    // As a MEMBER both copies keep the key and write `null` (only `undefined`
    // members are filtered), which is a deliberate divergence from
    // `JSON.stringify`, which would drop the key. Pinned because it is the one
    // place the two copies could drift apart by "fixing" it in only one.
    expect(canonicalJson({ a: 1, f: fn })).toBe(`{"a":1,"f":null}`);
    expect(emitted({ a: 1, f: fn }).evidenceDigest).toBe(sha256Hex(`{"a":1,"f":null}`));
  });

  test("a toJSON carrier is honoured BEFORE the array branch by both copies (C1)", () => {
    // Caught as real drift at the close gate: the two copies had landed the
    // toJSON check on OPPOSITE sides of `Array.isArray`, so an array carrying
    // its own `toJSON` rendered `[1,2]` in one and `"X"` in the other — a
    // silent digest disagreement between two functions that are byte-identical
    // by contract. `JSON.stringify` honours `toJSON` on arrays too, so the
    // toJSON-first ordering is the correct one and this test pins it.
    const stamp = new Date("2026-09-16T00:00:00.000Z");
    const iso = `"2026-09-16T00:00:00.000Z"`;
    expect(canonicalJson(stamp)).toBe(iso);
    expect(emitted(stamp).evidenceDigest).toBe(sha256Hex(iso));
    // A Date as a MEMBER survives as its ISO stamp, not as an empty object —
    // the silent evidence LOSS this ordering exists to prevent (the digest
    // would otherwise faithfully attest to `{}`).
    expect(canonicalJson({ at: stamp, n: 1 })).toBe(`{"at":${iso},"n":1}`);
    expect(emitted({ at: stamp, n: 1 }).evidenceDigest).toBe(sha256Hex(`{"at":${iso},"n":1}`));
    // The ordering itself: an ARRAY with a toJSON. This is the only value that
    // distinguishes the two placements, which is why it is asserted here.
    const arr: unknown[] & { toJSON?: () => unknown } = [1, 2];
    arr.toJSON = () => "X";
    expect(canonicalJson(arr)).toBe(`"X"`);
    expect(canonicalJson(arr)).toBe(JSON.stringify(arr));
    expect(emitted(arr).evidenceDigest).toBe(sha256Hex(`"X"`));
  });
});
