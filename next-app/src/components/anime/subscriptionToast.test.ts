import { describe, expect, test } from "bun:test";
import {
  LIST_HINT_KEY,
  LIST_HINT_TOAST_MS,
  takeListHint,
  type HintStore,
} from "./subscriptionToast";

// app/layout.tsx's <Toaster toastOptions={{ duration: 3500 }} />. Duplicated
// as a literal rather than imported because importing layout.tsx pulls the
// whole RSC tree into a unit test; if that default ever changes, this test
// failing is the intended outcome.
const TOASTER_DEFAULT_MS = 3500;

function fakeStore(seed: Record<string, string> = {}): HintStore {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe("LIST_HINT_TOAST_MS", () => {
  test("outlives the Toaster default, because this toast has to be acted on", () => {
    // The hint is one-time per browser: takeListHint marks it consumed the
    // moment it fires. A phone user tapping + at the bottom of a /seasonal
    // grid gets the toast top-center, and 3500ms can run out while their eyes
    // are still on the card — burning the only chance this device had to
    // learn where the list lives. The Undo action in the same toast has the
    // same problem with less forgiveness.
    expect(LIST_HINT_TOAST_MS).toBeGreaterThan(TOASTER_DEFAULT_MS);
  });

  test("is a duration in milliseconds, not seconds", () => {
    // A `7` here would read as "7" to react-hot-toast and dismiss instantly —
    // the exact failure the constant exists to prevent, and invisible in
    // review.
    expect(LIST_HINT_TOAST_MS).toBeGreaterThanOrEqual(5000);
    expect(LIST_HINT_TOAST_MS).toBeLessThanOrEqual(15000);
  });
});

describe("takeListHint", () => {
  test("fires on the first subscribe of a fresh browser", () => {
    expect(takeListHint(fakeStore())).toBe(true);
  });

  test("never fires twice — the second subscribe is a plain confirmation", () => {
    const store = fakeStore();
    expect(takeListHint(store)).toBe(true);
    expect(takeListHint(store)).toBe(false);
    expect(takeListHint(store)).toBe(false);
  });

  test("marks the flag so a later page load stays quiet", () => {
    const store = fakeStore();
    takeListHint(store);
    expect(store.getItem(LIST_HINT_KEY)).not.toBeNull();
    // A fresh store object over the same storage is the real second visit.
    expect(takeListHint(fakeStore({ [LIST_HINT_KEY]: "1" }))).toBe(false);
  });

  test("no store at all (SSR) suppresses the hint rather than throwing", () => {
    expect(takeListHint(null)).toBe(false);
  });

  test("a write-blocked store suppresses the hint", () => {
    // Safari private mode: reads fine, throws on write. Showing a hint we
    // cannot mark as consumed would repeat it on every single subscribe.
    const readOnly: HintStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(takeListHint(readOnly)).toBe(false);
    expect(takeListHint(readOnly)).toBe(false);
  });

  test("a read-blocked store suppresses the hint", () => {
    const hostile: HintStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    expect(takeListHint(hostile)).toBe(false);
  });

  test("answers synchronously — the decision costs no round trip", () => {
    // The constraint this pins: "is this their first subscription" must never
    // become a request. A synchronous boolean has nowhere to await an answer,
    // so anyone tempted to ask the server has to break this test first.
    const answer = takeListHint(fakeStore());
    expect(typeof answer).toBe("boolean");
    expect(answer).not.toBeInstanceOf(Promise);
  });
});
