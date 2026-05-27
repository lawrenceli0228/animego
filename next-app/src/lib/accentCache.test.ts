import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readAccent, writeAccent } from "./accentCache";

// In-memory localStorage shim — bun:test runs in node, no DOM by default.
function installLocalStorage() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = ls;
  (globalThis as { window?: unknown }).window = globalThis;
  return ls;
}

function uninstallLocalStorage() {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { window?: unknown }).window;
}

describe("accentCache", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    uninstallLocalStorage();
  });

  test("writeAccent then readAccent round-trips with source=server (default)", () => {
    writeAccent(189046, "#ff8800", "255, 136, 0");
    const got = readAccent(189046);
    expect(got).toEqual({
      accent: "#ff8800",
      rgb: "255, 136, 0",
      source: "server",
    });
  });

  test("source=client is preserved", () => {
    writeAccent(1, "#00aaff", "0, 170, 255", "client");
    expect(readAccent(1)?.source).toBe("client");
  });

  test("brand-violet fallback (#8B5CF6) is NOT cached", () => {
    writeAccent(7, "#8B5CF6", "139, 92, 246");
    expect(readAccent(7)).toBeNull();
  });

  test("brand-violet check is case-insensitive", () => {
    writeAccent(7, "#8b5cf6", "139, 92, 246");
    expect(readAccent(7)).toBeNull();
  });

  test("readAccent returns null for unknown id", () => {
    expect(readAccent(999)).toBeNull();
  });

  test("readAccent returns null for falsy id", () => {
    expect(readAccent(0)).toBeNull();
    expect(readAccent(null)).toBeNull();
    expect(readAccent(undefined)).toBeNull();
  });

  test("writeAccent is a no-op for falsy id / empty accent or rgb", () => {
    writeAccent(0, "#fff", "255, 255, 255");
    writeAccent(1, "", "1, 2, 3");
    writeAccent(2, "#fff", "");
    expect(readAccent(0)).toBeNull();
    expect(readAccent(1)).toBeNull();
    expect(readAccent(2)).toBeNull();
  });

  test("readAccent returns null when stored entry is past TTL (>7 days)", () => {
    // Manually insert a stale entry
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      "acc:42",
      JSON.stringify({
        accent: "#abcdef",
        rgb: "171, 205, 239",
        t: eightDaysAgo,
        source: "server",
      }),
    );
    expect(readAccent(42)).toBeNull();
    // And the stale entry should have been evicted by the read
    expect(localStorage.getItem("acc:42")).toBeNull();
  });

  test("readAccent returns the entry just under TTL (~6 days old)", () => {
    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      "acc:42",
      JSON.stringify({
        accent: "#abcdef",
        rgb: "171, 205, 239",
        t: sixDaysAgo,
        source: "server",
      }),
    );
    expect(readAccent(42)).toEqual({
      accent: "#abcdef",
      rgb: "171, 205, 239",
      source: "server",
    });
  });

  test("readAccent handles corrupt JSON without throwing", () => {
    localStorage.setItem("acc:42", "{not json}");
    expect(() => readAccent(42)).not.toThrow();
    expect(readAccent(42)).toBeNull();
  });

  test("readAccent rejects partial / malformed entries", () => {
    localStorage.setItem(
      "acc:1",
      JSON.stringify({ accent: "#fff", t: Date.now() }),
    );
    localStorage.setItem(
      "acc:2",
      JSON.stringify({ accent: 123, rgb: "1,2,3", t: Date.now() }),
    );
    expect(readAccent(1)).toBeNull();
    expect(readAccent(2)).toBeNull();
  });

  test("SSR safety: read/write are no-ops without window/localStorage", () => {
    uninstallLocalStorage();
    expect(readAccent(1)).toBeNull();
    expect(() => writeAccent(1, "#fff", "255, 255, 255")).not.toThrow();
  });
});
