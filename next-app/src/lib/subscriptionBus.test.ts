import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  broadcastSubscription,
  subscribeToBus,
  type SubscriptionChangeDetail,
} from "./subscriptionBus";

// bun runs every test file in ONE process, so a `window` left behind here is
// seen by every file that runs later. It used to be left behind: any later
// test importing next/image then died at import time, because next's
// deployment-id module reads `document` as soon as `window` exists. Put the
// global back exactly as it was found, the way pendingSubscribe.test.ts and
// communityEngagement.test.ts do.
const hadWindow = "window" in globalThis;
const originalWindow = (globalThis as { window?: unknown }).window;

describe("subscriptionBus", () => {
  beforeEach(() => {
    // bun:test runs in node — provide a window stub for the bus to attach to
    if (typeof globalThis.window === "undefined") {
      (globalThis as { window?: unknown }).window = globalThis;
    }
  });

  afterEach(() => {
    // Listeners need no cleanup (subscribeToBus returns an unsubscribe each
    // call); the window stub does.
    if (hadWindow) (globalThis as { window?: unknown }).window = originalWindow;
    else delete (globalThis as { window?: unknown }).window;
  });

  test("broadcasts reach a single subscriber with full detail", () => {
    const handler = mock<(d: SubscriptionChangeDetail) => void>(() => {});
    const unsub = subscribeToBus(handler);

    const detail: SubscriptionChangeDetail = {
      anilistId: 189046,
      sub: { status: "watching", currentEpisode: 6, score: null },
    };
    broadcastSubscription(detail);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual(detail);
    unsub();
  });

  test("broadcasts fan out to multiple subscribers", () => {
    const a = mock<(d: SubscriptionChangeDetail) => void>(() => {});
    const b = mock<(d: SubscriptionChangeDetail) => void>(() => {});
    const unsubA = subscribeToBus(a);
    const unsubB = subscribeToBus(b);

    broadcastSubscription({ anilistId: 1, sub: null });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });

  test("unsubscribe stops further notifications", () => {
    const handler = mock<(d: SubscriptionChangeDetail) => void>(() => {});
    const unsub = subscribeToBus(handler);
    unsub();

    broadcastSubscription({ anilistId: 1, sub: null });

    expect(handler).not.toHaveBeenCalled();
  });

  test("null sub (unsubscribe / signed out) propagates as-is", () => {
    const handler = mock<(d: SubscriptionChangeDetail) => void>(() => {});
    const unsub = subscribeToBus(handler);

    broadcastSubscription({ anilistId: 42, sub: null });

    expect(handler.mock.calls[0]?.[0]?.sub).toBeNull();
    unsub();
  });

  test("broadcast is safe on SSR (no window)", () => {
    const origWindow = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
    try {
      // Must not throw
      expect(() =>
        broadcastSubscription({ anilistId: 1, sub: null }),
      ).not.toThrow();
    } finally {
      (globalThis as { window?: unknown }).window = origWindow;
    }
  });

  test("subscribe returns a no-op unsubscribe on SSR", () => {
    const origWindow = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
    try {
      const unsub = subscribeToBus(() => {});
      expect(typeof unsub).toBe("function");
      // unsub must not throw
      expect(() => unsub()).not.toThrow();
    } finally {
      (globalThis as { window?: unknown }).window = origWindow;
    }
  });
});
