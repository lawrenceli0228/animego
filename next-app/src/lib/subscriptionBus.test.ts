import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  broadcastSubscription,
  subscribeToBus,
  type SubscriptionChangeDetail,
} from "./subscriptionBus";

describe("subscriptionBus", () => {
  beforeEach(() => {
    // bun:test runs in node — provide a window stub for the bus to attach to
    if (typeof globalThis.window === "undefined") {
      (globalThis as { window?: unknown }).window = globalThis;
    }
  });

  afterEach(() => {
    // Nothing else to clean: subscribeToBus returns an unsubscribe each call
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
