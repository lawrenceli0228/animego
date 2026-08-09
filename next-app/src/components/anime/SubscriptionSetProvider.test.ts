import { afterEach, describe, expect, test } from "bun:test";
import {
  ANONYMOUS_STATE,
  SIGNED_OUT_EVENT,
  SUBSCRIPTION_SET_FALLBACK,
  applySubscriptionChange,
  broadcastSignedOut,
  classifyCreateStatus,
  classifyDeleteStatus,
  nextSubscriptionSet,
  subscribeToSignedOut,
  subscribedIdsFromList,
} from "./subscriptionSetState";

// No RTL in this repo, so the provider's interesting behaviour is factored
// into pure reducers and tested here directly: envelope → Set, bus event →
// Set, the optimistic write lifecycle (paint → confirm | revert), how a write
// response is classified, and the sign-out signal that resets the whole thing.

describe("subscribedIdsFromList", () => {
  test("reads the standard { data: [...] } envelope", () => {
    const ids = subscribedIdsFromList({
      data: [
        { anilistId: 189046, status: "watching" },
        { anilistId: 21, status: "completed" },
      ],
    });
    expect([...ids].sort((a, b) => a - b)).toEqual([21, 189046]);
  });

  test("reads a bare array too", () => {
    expect([...subscribedIdsFromList([{ anilistId: 5 }])]).toEqual([5]);
  });

  test("an empty list yields an empty set (signed in, tracking nothing)", () => {
    expect(subscribedIdsFromList({ data: [] }).size).toBe(0);
  });

  test("null / undefined / non-object bodies degrade to empty, not a throw", () => {
    expect(subscribedIdsFromList(null).size).toBe(0);
    expect(subscribedIdsFromList(undefined).size).toBe(0);
    expect(subscribedIdsFromList("nope").size).toBe(0);
    expect(subscribedIdsFromList({ data: "nope" }).size).toBe(0);
  });

  test("skips malformed rows without losing the good ones", () => {
    // One bad row must cost that card its ✓, not the whole grid.
    const ids = subscribedIdsFromList({
      data: [
        { anilistId: 1 },
        null,
        "garbage",
        { anilistId: "2" },
        { status: "watching" },
        { anilistId: 0 },
        { anilistId: -3 },
        { anilistId: 4.5 },
        { anilistId: 7 },
      ],
    });
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 7]);
  });

  test("de-duplicates repeated ids", () => {
    expect(subscribedIdsFromList({ data: [{ anilistId: 9 }, { anilistId: 9 }] }).size).toBe(1);
  });
});

describe("applySubscriptionChange", () => {
  test("adds an id that was absent", () => {
    const before = new Set([1]);
    const after = applySubscriptionChange(before, 2, true);
    expect([...after].sort()).toEqual([1, 2]);
  });

  test("removes an id that was present", () => {
    const after = applySubscriptionChange(new Set([1, 2]), 1, false);
    expect([...after]).toEqual([2]);
  });

  test("never mutates the input set", () => {
    const before = new Set([1]);
    applySubscriptionChange(before, 2, true);
    expect([...before]).toEqual([1]);
  });

  test("returns the SAME reference when nothing changes", () => {
    // Every bus echo of our own write lands here. A fresh Set per echo would
    // re-render all 20+ cards in the grid for a no-op.
    const set = new Set([1]);
    expect(applySubscriptionChange(set, 1, true)).toBe(set);
    expect(applySubscriptionChange(set, 99, false)).toBe(set);
  });
});

describe("nextSubscriptionSet — optimistic write lifecycle", () => {
  test("add: optimistic paints it, confirm leaves it", () => {
    const base: ReadonlySet<number> = new Set([1]);
    const painted = nextSubscriptionSet(base, 2, "add", "optimistic");
    expect(painted.has(2)).toBe(true);
    const confirmed = nextSubscriptionSet(painted, 2, "add", "confirmed");
    expect(confirmed.has(2)).toBe(true);
    expect(confirmed).toBe(painted); // no-op, so no re-render
  });

  test("add: revert undoes the optimistic paint exactly", () => {
    const base: ReadonlySet<number> = new Set([1]);
    const painted = nextSubscriptionSet(base, 2, "add", "optimistic");
    const reverted = nextSubscriptionSet(painted, 2, "add", "reverted");
    expect([...reverted]).toEqual([...base]);
  });

  test("remove: optimistic drops it, confirm leaves it dropped", () => {
    const base: ReadonlySet<number> = new Set([1, 2]);
    const painted = nextSubscriptionSet(base, 2, "remove", "optimistic");
    expect(painted.has(2)).toBe(false);
    expect(nextSubscriptionSet(painted, 2, "remove", "confirmed")).toBe(painted);
  });

  test("remove: revert puts it back", () => {
    const base: ReadonlySet<number> = new Set([1, 2]);
    const painted = nextSubscriptionSet(base, 2, "remove", "optimistic");
    const reverted = nextSubscriptionSet(painted, 2, "remove", "reverted");
    expect([...reverted].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  test("a failed add on a card that was somehow already tracked reverts to absent", () => {
    // Documents the tradeoff: rollback applies the inverse of the intent, not
    // a snapshot. Only reachable if a write were issued while another was in
    // flight, which the per-card busy guard prevents.
    const painted: ReadonlySet<number> = new Set([2]);
    expect(nextSubscriptionSet(painted, 2, "add", "reverted").has(2)).toBe(false);
  });

  test("the whole lifecycle leaves other ids untouched", () => {
    const base: ReadonlySet<number> = new Set([10, 20, 30]);
    const out = nextSubscriptionSet(
      nextSubscriptionSet(base, 40, "add", "optimistic"),
      40,
      "add",
      "reverted",
    );
    expect([...out].sort((a, b) => a - b)).toEqual([10, 20, 30]);
  });
});

describe("classifyCreateStatus — POST /api/subscriptions", () => {
  test("2xx is success", () => {
    expect(classifyCreateStatus(200)).toBe("success");
    expect(classifyCreateStatus(201)).toBe("success");
    expect(classifyCreateStatus(204)).toBe("success");
  });

  test("401 is its own verdict, not a failure", () => {
    // The session died between the list load and the click. Rolling one card
    // back would leave the other nineteen ✓s lying about a session that is
    // gone; the whole grid has to drop to signed-out.
    expect(classifyCreateStatus(401)).toBe("signedOut");
  });

  test("404 on a CREATE is a real failure", () => {
    // The asymmetry with DELETE, pinned deliberately. go-api answers 404 here
    // when the anilistId is not in anime_cache and AniList could not be
    // reached to fill it — no row exists, so a ✓ would be a lie.
    expect(classifyCreateStatus(404)).toBe("failed");
  });

  test("409 / 429 / 5xx are failures", () => {
    expect(classifyCreateStatus(409)).toBe("failed");
    expect(classifyCreateStatus(429)).toBe("failed");
    expect(classifyCreateStatus(500)).toBe("failed");
    expect(classifyCreateStatus(503)).toBe("failed");
  });
});

describe("classifyDeleteStatus — DELETE /api/subscriptions/:id", () => {
  test("2xx is success", () => {
    expect(classifyDeleteStatus(200)).toBe("success");
    expect(classifyDeleteStatus(204)).toBe("success");
  });

  test("404 is SUCCESS — DELETE is idempotent", () => {
    // The reviewed failure: two tabs on /seasonal, the first removes a show,
    // the second still has it in the set it loaded at page open. Clicking ✓
    // there 404s. Treating that as a failure rolled the ✓ back on, and since
    // the row was already gone every subsequent click 404'd identically — a
    // card stuck advertising a subscription the server does not have, with no
    // way out but a reload. "Already gone" is the state the caller asked for.
    expect(classifyDeleteStatus(404)).toBe("success");
  });

  test("401 still drops to signed-out", () => {
    expect(classifyDeleteStatus(401)).toBe("signedOut");
  });

  test("403 / 429 / 5xx remain failures", () => {
    // 404 is generous, not blanket forgiveness: these leave the row in place,
    // so the optimistic removal must roll back.
    expect(classifyDeleteStatus(403)).toBe("failed");
    expect(classifyDeleteStatus(429)).toBe("failed");
    expect(classifyDeleteStatus(500)).toBe("failed");
    expect(classifyDeleteStatus(502)).toBe("failed");
  });

  test("the create/delete verdicts differ on 404 and only on 404", () => {
    // Any status where the two disagree is a decision someone made on purpose.
    const disagree = [200, 201, 204, 400, 401, 403, 404, 409, 429, 500].filter(
      (s) => classifyCreateStatus(s) !== classifyDeleteStatus(s),
    );
    expect(disagree).toEqual([404]);
  });
});

describe("ANONYMOUS_STATE — what a sign-out resets to", () => {
  test("is settled, unknown, and EMPTY", () => {
    // The empty id set is the load-bearing half. Dropping `known` alone would
    // hide the ✓s while the previous account's ids stayed in memory — one
    // stray flip from repainting a stranger's watchlist onto the screen.
    expect(ANONYMOUS_STATE.ready).toBe(true);
    expect(ANONYMOUS_STATE.known).toBe(false);
    expect(ANONYMOUS_STATE.ids.size).toBe(0);
  });

  test("presents the same face as having no provider at all", () => {
    // A signed-out grid and a grid nobody wrapped must be indistinguishable to
    // a card, or the two paths drift and only one of them gets fixed.
    expect(ANONYMOUS_STATE.ready).toBe(SUBSCRIPTION_SET_FALLBACK.ready);
    expect(ANONYMOUS_STATE.known).toBe(SUBSCRIPTION_SET_FALLBACK.known);
  });
});

describe("sign-out signal", () => {
  // The provider cannot ask a cookie to notify it, so Navbar announces the
  // logout and every account-scoped view listens. That contract spans two
  // files, which is exactly why the wire itself is worth a test.
  const hadWindow = "window" in globalThis;
  const originalWindow = (globalThis as { window?: unknown }).window;

  function installWindow(): void {
    (globalThis as { window?: unknown }).window = new EventTarget();
  }

  afterEach(() => {
    if (hadWindow) (globalThis as { window?: unknown }).window = originalWindow;
    else delete (globalThis as { window?: unknown }).window;
  });

  test("the event name is namespaced and stable", () => {
    // Navbar imports this constant rather than typing the string, but a
    // rename would still silently unhook every listener — the emitter and the
    // listener both keep working, they just stop meeting.
    expect(SIGNED_OUT_EVENT).toBe("animego:auth:signed-out");
  });

  test("a broadcast reaches a subscriber", () => {
    installWindow();
    let hits = 0;
    subscribeToSignedOut(() => {
      hits += 1;
    });
    broadcastSignedOut();
    expect(hits).toBe(1);
  });

  test("reaches EVERY subscriber — a page can hold several grids", () => {
    // The home page mounts TrendingSection's provider; a seasonal page mounts
    // its own. Context could not reach both from the navbar; a window event
    // does.
    installWindow();
    const seen: string[] = [];
    subscribeToSignedOut(() => seen.push("trending"));
    subscribeToSignedOut(() => seen.push("seasonal"));
    broadcastSignedOut();
    expect(seen.sort()).toEqual(["seasonal", "trending"]);
  });

  test("unsubscribing stops delivery", () => {
    installWindow();
    let hits = 0;
    const off = subscribeToSignedOut(() => {
      hits += 1;
    });
    off();
    broadcastSignedOut();
    expect(hits).toBe(0);
  });

  test("a second logout click re-notifies rather than being swallowed", () => {
    installWindow();
    let hits = 0;
    subscribeToSignedOut(() => {
      hits += 1;
    });
    broadcastSignedOut();
    broadcastSignedOut();
    expect(hits).toBe(2);
  });

  test("broadcasting with nobody listening is harmless", () => {
    installWindow();
    expect(() => broadcastSignedOut()).not.toThrow();
  });

  test("both halves are inert during SSR instead of throwing", () => {
    // The module is imported by server-rendered trees; touching `window` at
    // module scope or on call would break the build, not just the feature.
    delete (globalThis as { window?: unknown }).window;
    expect(() => broadcastSignedOut()).not.toThrow();
    const off = subscribeToSignedOut(() => {
      throw new Error("must never run");
    });
    expect(() => off()).not.toThrow();
  });
});

describe("useSubscriptionSet without a provider", () => {
  // useSubscriptionSet is `useContext(ctx) ?? SUBSCRIPTION_SET_FALLBACK`, and
  // useContext cannot run outside a component tree — so the assertable half is
  // the fallback itself. A page that forgets the provider must get a settled,
  // inert API rather than a thrown render or a permanent loading state.
  const api = SUBSCRIPTION_SET_FALLBACK;

  test("settles immediately as a signed-out viewer", () => {
    expect(api.ready).toBe(true);
    expect(api.known).toBe(false);
  });

  test("has() is always false", () => {
    expect(api.has(189046)).toBe(false);
  });

  test("writes are inert no-ops that resolve false", async () => {
    expect(await api.add(189046)).toBe(false);
    expect(await api.remove(189046)).toBe(false);
  });
});
