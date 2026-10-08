/**
 * JudgmentProvider registry tests (v6 J1 AC2, DD-21 seam half).
 *
 * The registry is a module-level closed constant seeded with exactly two
 * adapter makers. Extension is a code change plus contract-suite membership
 * (tests/judgment/adapter-contract.test.ts) — never a runtime call — so this
 * suite pins the closure three ways: the frozen constant refuses every
 * mutation path, the module exports no registration verb, and resolution
 * refuses any id that is not an own key of the constant.
 */
import { describe, expect, test } from "bun:test";
import { makeJevProvider } from "../../src/judgment/adapters/jev.ts";
import { makeMockProvider } from "../../src/judgment/adapters/mock.ts";
import * as providerModule from "../../src/judgment/provider.ts";
import {
  JUDGMENT_PROVIDER_IDS,
  JUDGMENT_PROVIDERS,
  resolveProvider,
  UnknownProviderError,
} from "../../src/judgment/provider.ts";

describe("closed registry", () => {
  test("seeded with exactly the two adapters, in a pinned order", () => {
    expect([...JUDGMENT_PROVIDER_IDS]).toEqual(["jev", "mock"]);
    expect(Object.keys(JUDGMENT_PROVIDERS)).toEqual(["jev", "mock"]);
  });

  test("resolveProvider returns the registered adapter makers", () => {
    expect(resolveProvider("jev")).toBe(makeJevProvider);
    expect(resolveProvider("mock")).toBe(makeMockProvider);
  });

  test("the registry constant and its id list are frozen — every mutation path throws", () => {
    expect(Object.isFrozen(JUDGMENT_PROVIDERS)).toBe(true);
    expect(Object.isFrozen(JUDGMENT_PROVIDER_IDS)).toBe(true);
    const registry = JUDGMENT_PROVIDERS as unknown as Record<string, unknown>;
    // ES modules are strict mode: a write to a frozen object throws, it is
    // never a silent no-op.
    expect(() => {
      registry.rogue = makeMockProvider;
    }).toThrow(TypeError);
    expect(() => {
      registry.mock = makeJevProvider;
    }).toThrow(TypeError);
    expect(() => {
      // biome-ignore lint/performance/noDelete: asserting delete is refused
      delete registry.jev;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(registry, "rogue", { value: makeMockProvider })).toThrow(TypeError);
    expect(() => (JUDGMENT_PROVIDER_IDS as unknown as string[]).push("rogue")).toThrow(TypeError);
    expect(Object.keys(JUDGMENT_PROVIDERS)).toEqual(["jev", "mock"]);
  });

  test("the module exports no registration or mutation verb — only the closed surface", () => {
    // A runtime registerProvider()/addProvider() would let a transport no
    // contract test has run onto the seam (story Technical Notes, rejected).
    expect(Object.keys(providerModule).sort()).toEqual([
      "JUDGMENT_PROVIDERS",
      "JUDGMENT_PROVIDER_IDS",
      "UnknownProviderError",
      "resolveProvider",
    ]);
  });
});

describe("resolveProvider refusal (typed unknown-provider, before any request exists)", () => {
  // Prototype keys are the classic hole in an object-keyed registry: `in` and
  // bracket lookup both see Object.prototype members.
  const unknown = ["", "Jev", "MOCK", "openai", "toString", "constructor", "__proto__", "hasOwnProperty"];

  for (const id of unknown) {
    test(`refuses ${JSON.stringify(id)}`, () => {
      let caught: unknown;
      try {
        resolveProvider(id);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnknownProviderError);
      const err = caught as UnknownProviderError;
      expect(err.code).toBe("unknown-provider");
      expect(err.providerId).toBe(id);
      expect(err.message).toContain("jev | mock");
    });
  }

  test("a non-string id refuses typed too (callers at a JSON boundary)", () => {
    expect(() => resolveProvider(undefined as unknown as string)).toThrow(UnknownProviderError);
    expect(() => resolveProvider(1 as unknown as string)).toThrow(UnknownProviderError);
  });
});

describe("adapter makers", () => {
  test("the mock maker takes no configuration at all — no key path is a type fact", () => {
    expect(makeMockProvider.length).toBe(0);
  });

  test("each made adapter is a frozen { id, ask } and nothing else", () => {
    const jev = makeJevProvider({ apiKey: "k", baseUrl: "http://judgment.test", timeoutMs: 1 });
    const mock = makeMockProvider();
    for (const [id, adapter] of [
      ["jev", jev],
      ["mock", mock],
    ] as const) {
      expect(adapter.id).toBe(id);
      expect(Object.keys(adapter).sort()).toEqual(["ask", "id"]);
      expect(typeof adapter.ask).toBe("function");
      expect(Object.isFrozen(adapter)).toBe(true);
    }
  });

  test("the jev adapter never exposes the key it closes over", () => {
    const jev = makeJevProvider({ apiKey: "SECRETKEYVALUE123", baseUrl: "http://judgment.test", timeoutMs: 1 });
    expect(JSON.stringify(jev)).not.toContain("SECRETKEYVALUE123");
    expect(Object.values(jev)).not.toContain("SECRETKEYVALUE123");
  });
});
