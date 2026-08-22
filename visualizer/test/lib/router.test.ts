/**
 * DF4.2 unit tests for src/lib/router.ts (AC1).
 *
 * router.ts touches `window` at module-evaluation time (parse() runs
 * immediately to seed the initial route, and it registers a `hashchange`
 * listener) — bun has no DOM, so importing it unmodified throws
 * ReferenceError: window is not defined. This is NOT a DOM test harness:
 * it's the smallest object shape (`location.hash` + `addEventListener`)
 * that lets the module's real, exported logic run and be asserted on. A
 * static `import` would still evaluate router.ts (via hoisting) before this
 * shim runs, so the import is dynamic and deferred until after the shim is
 * installed.
 */
import { describe, expect, test } from "bun:test";

const listeners = new Map<string, Array<() => void>>();
const fakeLocation = { hash: "" };

(globalThis as unknown as { window: unknown }).window = {
  location: fakeLocation,
  addEventListener(type: string, cb: () => void) {
    const arr = listeners.get(type) ?? [];
    arr.push(cb);
    listeners.set(type, arr);
  },
};

function fireHashChange(): void {
  for (const cb of listeners.get("hashchange") ?? []) cb();
}

const { useRoute, hrefFor, navigate, phaseCrumb } = await import("../../src/lib/router.ts");

describe("useRoute — initial parse at module load", () => {
  test("returns a ref whose value reflects window.location.hash at import time", () => {
    // fakeLocation.hash was "" at the moment router.ts was imported above.
    const route = useRoute();
    expect(route.value).toEqual({ requestId: null, phaseId: null });
  });

  test("useRoute() returns the same underlying ref on repeated calls", () => {
    expect(useRoute()).toBe(useRoute());
  });
});

describe("hrefFor", () => {
  test("no ids → the bare root hash", () => {
    expect(hrefFor()).toBe("#/");
    expect(hrefFor(null, null)).toBe("#/");
  });

  test("requestId only", () => {
    expect(hrefFor("req-1")).toBe("#/req-1");
  });

  test("requestId + phaseId", () => {
    expect(hrefFor("req-1", "phase-1")).toBe("#/req-1/phase-1");
  });

  test("phaseId without a requestId is dropped, not appended to the root", () => {
    expect(hrefFor(null, "phase-1")).toBe("#/");
  });

  test("URL-encodes both segments", () => {
    expect(hrefFor("req/1", "phase 1")).toBe(`#/${encodeURIComponent("req/1")}/${encodeURIComponent("phase 1")}`);
  });
});

describe("navigate + hashchange → route updates", () => {
  test("navigating to a request id updates window.location.hash and, once hashchange fires, the route", () => {
    navigate("req-2", "phase-2");
    expect(fakeLocation.hash).toBe("#/req-2/phase-2");
    fireHashChange();
    expect(useRoute().value).toEqual({ requestId: "req-2", phaseId: "phase-2" });
  });

  test("navigating with no arguments returns to the root route", () => {
    navigate();
    fireHashChange();
    expect(useRoute().value).toEqual({ requestId: null, phaseId: null });
  });

  test("a malformed percent-escape in the hash degrades to the raw segment instead of throwing", () => {
    fakeLocation.hash = "#/%zz/ok";
    fireHashChange();
    expect(useRoute().value).toEqual({ requestId: "%zz", phaseId: "ok" });
  });
});

describe("phaseCrumb", () => {
  test("starts null and is a plain settable ref", () => {
    expect(phaseCrumb.value).toBeNull();
    phaseCrumb.value = "Engineer";
    expect(phaseCrumb.value).toBe("Engineer");
  });
});
