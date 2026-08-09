import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PENDING_TTL_MS,
  clearPendingSubscribe,
  currentPath,
  decodePendingSubscribe,
  encodePendingSubscribe,
  normalizePath,
  stashPendingSubscribe,
  takePendingSubscribe,
} from "./pendingSubscribe";

// bun:test runs in node — no window, no sessionStorage, no location. Both
// halves of this suite install their own stub: the decoder tests need none,
// the round-trip tests need a Storage-shaped object (which we can also make
// hostile — throwing getters, throwing setItem — to prove the module never
// lets a blocked storage API turn into a broken button) plus a location whose
// pathname we control, because the intent is bound to the page it was made on.

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const hadWindow = "window" in globalThis;
const originalWindow = (globalThis as { window?: unknown }).window;

const GRID = "/seasonal/summer/2026";

function installStorage(
  store: StorageLike | (() => never),
  pathname = GRID,
): void {
  const win: Record<string, unknown> = { location: { pathname } };
  if (typeof store === "function") {
    // Property ACCESS throws — Safari private mode / "block all cookies".
    Object.defineProperty(win, "sessionStorage", { get: store });
  } else {
    win.sessionStorage = store;
  }
  (globalThis as { window?: unknown }).window = win;
}

/** Move the browser to another page without touching the stash. */
function navigateTo(pathname: string): void {
  (globalThis as { window?: { location?: { pathname: string } } }).window!.location = {
    pathname,
  };
}

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

afterEach(() => {
  if (hadWindow) (globalThis as { window?: unknown }).window = originalWindow;
  else delete (globalThis as { window?: unknown }).window;
});

describe("normalizePath", () => {
  test("leaves a plain path alone", () => {
    expect(normalizePath("/seasonal/summer/2026")).toBe("/seasonal/summer/2026");
  });

  test("drops a trailing slash so /search and /search/ are the same page", () => {
    // The only drift we expect between the URL the + was pressed on and the
    // URL the login redirect lands on.
    expect(normalizePath("/search/")).toBe("/search");
  });

  test("keeps root as root rather than emptying it", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });
});

describe("currentPath", () => {
  test("reads the live pathname, normalised", () => {
    installStorage(memoryStorage(), "/search/");
    expect(currentPath()).toBe("/search");
  });

  test("is root, not a throw, with no window at all (SSR import)", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(currentPath()).toBe("/");
  });

  test("is root when location is missing", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(currentPath()).toBe("/");
  });
});

describe("decodePendingSubscribe", () => {
  const NOW = 1_700_000_000_000;

  test("round-trips a fresh intent read back on the same page", () => {
    const raw = encodePendingSubscribe(189046, NOW, GRID);
    expect(decodePendingSubscribe(raw, NOW + 1_000, GRID)).toBe(189046);
  });

  test("accepts an intent right at the TTL boundary", () => {
    const raw = encodePendingSubscribe(1, NOW, GRID);
    expect(decodePendingSubscribe(raw, NOW + PENDING_TTL_MS, GRID)).toBe(1);
  });

  test("drops an intent one millisecond past the TTL", () => {
    // The scenario the TTL exists for: someone else sits down at the same
    // browser, logs in, and inherits a write they never made.
    const raw = encodePendingSubscribe(1, NOW, GRID);
    expect(decodePendingSubscribe(raw, NOW + PENDING_TTL_MS + 1, GRID)).toBeNull();
  });

  test("the TTL is short enough to expire inside one abandoned sitting", () => {
    // Guards the constant itself: the reviewed failure has a second person
    // arriving five minutes later, so a TTL at or above that is the bug.
    expect(PENDING_TTL_MS).toBeLessThan(5 * 60 * 1000);
  });

  test("keeps an intent whose timestamp is in the future (clock moved back)", () => {
    const raw = encodePendingSubscribe(42, NOW + 60_000, GRID);
    expect(decodePendingSubscribe(raw, NOW, GRID)).toBe(42);
  });

  test("refuses an intent surfacing on a different page", () => {
    // Pressed + on the seasonal grid, abandoned, then logged in from the
    // navbar for an unrelated reason and landed on the home page. Nothing on
    // screen would explain the write, so there is no write.
    const raw = encodePendingSubscribe(189046, NOW, GRID);
    expect(decodePendingSubscribe(raw, NOW + 1_000, "/")).toBeNull();
  });

  test("refuses an intent from a sibling page of the same section", () => {
    const raw = encodePendingSubscribe(189046, NOW, "/seasonal/summer/2026");
    expect(
      decodePendingSubscribe(raw, NOW + 1_000, "/seasonal/spring/2026"),
    ).toBeNull();
  });

  test("tolerates trailing-slash drift on the return trip", () => {
    const raw = encodePendingSubscribe(7, NOW, "/search");
    expect(decodePendingSubscribe(raw, NOW + 1_000, "/search/")).toBe(7);
  });

  test("ignores the query string — same page, different view", () => {
    // encode/decode are given pathnames only; this pins that the caller's
    // search params can never be the reason a legitimate replay is refused.
    const raw = encodePendingSubscribe(7, NOW, "/search");
    expect(decodePendingSubscribe(raw, NOW + 1_000, "/search")).toBe(7);
  });

  test("rejects a record with no path (older build / hand-written)", () => {
    // Unbindable, therefore unusable. Costs one deploy's worth of in-flight
    // intents and closes the hole they would otherwise leave open.
    expect(
      decodePendingSubscribe(`{"anilistId":7,"ts":${NOW}}`, NOW, GRID),
    ).toBeNull();
    expect(
      decodePendingSubscribe(`{"anilistId":7,"ts":${NOW},"path":""}`, NOW, GRID),
    ).toBeNull();
    expect(
      decodePendingSubscribe(`{"anilistId":7,"ts":${NOW},"path":5}`, NOW, GRID),
    ).toBeNull();
  });

  test("returns null for an absent value", () => {
    expect(decodePendingSubscribe(null, NOW, GRID)).toBeNull();
    expect(decodePendingSubscribe("", NOW, GRID)).toBeNull();
  });

  test("returns null for non-JSON garbage instead of throwing", () => {
    expect(decodePendingSubscribe("not json {", NOW, GRID)).toBeNull();
  });

  test("returns null for JSON that is not an object", () => {
    expect(decodePendingSubscribe("189046", NOW, GRID)).toBeNull();
    expect(decodePendingSubscribe("null", NOW, GRID)).toBeNull();
    expect(decodePendingSubscribe('"189046"', NOW, GRID)).toBeNull();
  });

  test("rejects a non-numeric or non-positive anilistId", () => {
    const p = `"path":"${GRID}"`;
    expect(decodePendingSubscribe(`{"anilistId":"7","ts":${NOW},${p}}`, NOW, GRID)).toBeNull();
    expect(decodePendingSubscribe(`{"anilistId":0,"ts":${NOW},${p}}`, NOW, GRID)).toBeNull();
    expect(decodePendingSubscribe(`{"anilistId":-5,"ts":${NOW},${p}}`, NOW, GRID)).toBeNull();
    expect(decodePendingSubscribe(`{"anilistId":1.5,"ts":${NOW},${p}}`, NOW, GRID)).toBeNull();
  });

  test("rejects a record with a missing or unusable timestamp", () => {
    const p = `"path":"${GRID}"`;
    expect(decodePendingSubscribe(`{"anilistId":7,${p}}`, NOW, GRID)).toBeNull();
    expect(
      decodePendingSubscribe(`{"anilistId":7,"ts":"yesterday",${p}}`, NOW, GRID),
    ).toBeNull();
  });
});

describe("stash / take round trip", () => {
  beforeEach(() => {
    installStorage(memoryStorage());
  });

  test("take returns what stash wrote when the page has not moved", () => {
    stashPendingSubscribe(21);
    expect(takePendingSubscribe()).toBe(21);
  });

  test("survives the real round trip: same path, query dropped on return", () => {
    // /login?from=/search?q=… brings the visitor back to the same pathname;
    // whether the query survives is not evidence about who they are.
    installStorage(memoryStorage(), "/search");
    stashPendingSubscribe(21);
    navigateTo("/search");
    expect(takePendingSubscribe()).toBe(21);
  });

  test("take clears the intent — a second read finds nothing", () => {
    // Read-and-clear is what stops a failed replay from retrying on every
    // page the provider mounts on.
    stashPendingSubscribe(21);
    expect(takePendingSubscribe()).toBe(21);
    expect(takePendingSubscribe()).toBeNull();
  });

  test("a second stash overwrites the first (last poster pressed wins)", () => {
    stashPendingSubscribe(1);
    stashPendingSubscribe(2);
    expect(takePendingSubscribe()).toBe(2);
  });

  test("take on an empty jar is null", () => {
    expect(takePendingSubscribe()).toBeNull();
  });

  test("an intent stashed on one page is refused on another", () => {
    // The reviewed failure: press + on the grid, abandon, log in later from
    // the navbar, land on the home page — and find a show you never added.
    stashPendingSubscribe(99);
    navigateTo("/");
    expect(takePendingSubscribe()).toBeNull();
  });

  test("a refused intent is CONSUMED, not left to fire on a later visit", () => {
    // Otherwise navigating back to the grid would spring the write that the
    // path check just decided it could not trust.
    const store = memoryStorage();
    installStorage(store, GRID);
    stashPendingSubscribe(99);
    navigateTo("/");
    expect(takePendingSubscribe()).toBeNull();
    expect(store.map.size).toBe(0);
    navigateTo(GRID);
    expect(takePendingSubscribe()).toBeNull();
  });

  test("an expired stored record is dropped AND cleared", () => {
    const store = memoryStorage();
    installStorage(store, GRID);
    store.map.set(
      "animego:pendingSubscribe",
      encodePendingSubscribe(99, Date.now() - PENDING_TTL_MS - 1, GRID),
    );
    expect(takePendingSubscribe()).toBeNull();
    expect(store.map.size).toBe(0);
  });
});

describe("clearPendingSubscribe", () => {
  test("drops a stashed intent without reading it", () => {
    // What the provider calls when it settles on an anonymous viewer, and on
    // sign-out: there is no session to replay into, and whoever signs in next
    // is not necessarily the person who pressed +.
    const store = memoryStorage();
    installStorage(store, GRID);
    stashPendingSubscribe(21);
    expect(store.map.size).toBe(1);
    clearPendingSubscribe();
    expect(store.map.size).toBe(0);
    expect(takePendingSubscribe()).toBeNull();
  });

  test("is a no-op on an empty jar", () => {
    installStorage(memoryStorage());
    expect(() => clearPendingSubscribe()).not.toThrow();
  });

  test("never throws when storage is blocked or absent", () => {
    installStorage(() => {
      throw new Error("SecurityError: storage blocked");
    });
    expect(() => clearPendingSubscribe()).not.toThrow();
    installStorage({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(() => clearPendingSubscribe()).not.toThrow();
    delete (globalThis as { window?: unknown }).window;
    expect(() => clearPendingSubscribe()).not.toThrow();
  });
});

describe("storage unavailable", () => {
  test("stash is a no-op when sessionStorage access throws", () => {
    installStorage(() => {
      throw new Error("SecurityError: storage blocked");
    });
    expect(() => stashPendingSubscribe(7)).not.toThrow();
  });

  test("take returns null when sessionStorage access throws", () => {
    installStorage(() => {
      throw new Error("SecurityError: storage blocked");
    });
    expect(takePendingSubscribe()).toBeNull();
  });

  test("stash survives a throwing setItem (quota / private mode)", () => {
    installStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    });
    expect(() => stashPendingSubscribe(7)).not.toThrow();
  });

  test("take survives a throwing getItem", () => {
    installStorage({
      getItem: () => {
        throw new Error("QuotaExceededError");
      },
      setItem: () => {},
      removeItem: () => {},
    });
    expect(takePendingSubscribe()).toBeNull();
  });

  test("both are safe with no window at all (SSR import)", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => stashPendingSubscribe(7)).not.toThrow();
    expect(takePendingSubscribe()).toBeNull();
  });
});
