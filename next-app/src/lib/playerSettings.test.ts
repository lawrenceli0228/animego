import { describe, expect, test } from "bun:test";
import {
  AUTO_MARK_DONE_KEY,
  DANMAKU_SPEED_DEFAULT,
  DANMAKU_SPEED_KEY,
  DANMAKU_SPEED_MAX,
  DANMAKU_SPEED_MIN,
  DANMAKU_SPEED_STEPS,
  readDanmakuSpeed,
  speedLadderIsRenderable,
  writeDanmakuSpeed,
  prefStore,
  readAutoMarkDone,
  subscribeAutoMarkDone,
  writeAutoMarkDone,
  type PrefStore,
} from "./playerSettings";

/** In-memory stand-in for localStorage — bun:test runs in node, no DOM. */
function fakeStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    raw: map,
  };
}

/** A store that fails the way Safari private mode / a full quota fails. */
function throwingStore(): PrefStore {
  return {
    getItem: () => {
      throw new Error("storage disabled");
    },
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };
}

/** Minimal event target — bun:test has no DOM, so window has to be faked. */
function fakeWindow(localStorage?: PrefStore) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    localStorage,
    listeners,
    addEventListener: (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (event: { type: string }) => {
      for (const fn of listeners.get(event.type) ?? []) fn();
      return true;
    },
  };
}

/** Swap `globalThis.window` for the body of one test, then put it back. */
function withWindow(value: unknown, body: () => void): void {
  const had = "window" in globalThis;
  const before = (globalThis as { window?: unknown }).window;
  if (value === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = value;
  try {
    body();
  } finally {
    if (had) (globalThis as { window?: unknown }).window = before;
    else delete (globalThis as { window?: unknown }).window;
  }
}

describe("readAutoMarkDone", () => {
  test("is on when the switch has never been touched", () => {
    // Arrange
    const store = fakeStore();

    // Act
    const on = readAutoMarkDone(store);

    // Assert
    expect(on).toBe(true);
  });

  test("is off once the user has turned it off", () => {
    const store = fakeStore({ [AUTO_MARK_DONE_KEY]: "0" });

    expect(readAutoMarkDone(store)).toBe(false);
  });

  test("is on once the user has turned it back on", () => {
    const store = fakeStore({ [AUTO_MARK_DONE_KEY]: "1" });

    expect(readAutoMarkDone(store)).toBe(true);
  });

  test("a value we did not write falls back to on, never to off", () => {
    // An opt-out switch must not be disabled by a value nobody chose.
    for (const junk of ["", "true", "false", "yes", "{}", "2"]) {
      const store = fakeStore({ [AUTO_MARK_DONE_KEY]: junk });

      expect(readAutoMarkDone(store)).toBe(true);
    }
  });

  test("a store that throws on read falls back to on instead of crashing", () => {
    const store = throwingStore();

    expect(() => readAutoMarkDone(store)).not.toThrow();
    expect(readAutoMarkDone(store)).toBe(true);
  });

  test("no reachable storage (SSR) reads as on", () => {
    expect(readAutoMarkDone(null)).toBe(true);
  });
});

describe("writeAutoMarkDone", () => {
  test("what it writes is what the next read returns", () => {
    // Arrange
    const store = fakeStore();

    // Act
    const savedOff = writeAutoMarkDone(false, store);
    const afterOff = readAutoMarkDone(store);
    const savedOn = writeAutoMarkDone(true, store);
    const afterOn = readAutoMarkDone(store);

    // Assert
    expect([savedOff, afterOff, savedOn, afterOn]).toEqual([true, false, true, true]);
  });

  test("stores under the shared namespaced key", () => {
    // Pinned as a literal: renaming the key silently re-enables the feature
    // for every user who had turned it off, since an unknown key reads as on.
    const store = fakeStore();

    writeAutoMarkDone(false, store);

    expect(AUTO_MARK_DONE_KEY).toBe("animego:autoMarkDone");
    expect(store.raw.get("animego:autoMarkDone")).toBe("0");
  });

  test("reports failure rather than pretending a full store saved it", () => {
    const store = throwingStore();

    expect(() => writeAutoMarkDone(false, store)).not.toThrow();
    expect(writeAutoMarkDone(false, store)).toBe(false);
  });

  test("reports failure when there is no reachable storage (SSR)", () => {
    expect(writeAutoMarkDone(false, null)).toBe(false);
  });

  test("a failed write leaves the stored answer alone", () => {
    // The player keeps reading the old value, so the UI must not claim the new
    // one. Nothing here should have changed the on/off answer.
    const store = throwingStore();

    writeAutoMarkDone(false, store);

    expect(readAutoMarkDone(store)).toBe(true);
  });
});

describe("subscribeAutoMarkDone", () => {
  test("a successful write wakes this tab's listeners", () => {
    // Arrange
    const store = fakeStore();
    const win = fakeWindow(store);
    let woken = 0;

    // Act
    withWindow(win, () => {
      subscribeAutoMarkDone(() => {
        woken += 1;
      });
      writeAutoMarkDone(false, store);
    });

    // Assert
    expect(woken).toBe(1);
  });

  test("a write another tab made wakes us too (the browser's storage event)", () => {
    const win = fakeWindow();
    let woken = 0;

    withWindow(win, () => {
      subscribeAutoMarkDone(() => {
        woken += 1;
      });
      win.dispatchEvent({ type: "storage" });
    });

    expect(woken).toBe(1);
  });

  test("a failed write wakes nobody — there is nothing new to read", () => {
    const win = fakeWindow();
    let woken = 0;

    withWindow(win, () => {
      subscribeAutoMarkDone(() => {
        woken += 1;
      });
      writeAutoMarkDone(false, throwingStore());
    });

    expect(woken).toBe(0);
  });

  test("unsubscribing detaches every listener it attached", () => {
    const store = fakeStore();
    const win = fakeWindow(store);
    let woken = 0;

    withWindow(win, () => {
      const unsubscribe = subscribeAutoMarkDone(() => {
        woken += 1;
      });
      unsubscribe();
      writeAutoMarkDone(false, store);
      win.dispatchEvent({ type: "storage" });
    });

    expect(woken).toBe(0);
    expect([...win.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });

  test("subscribing during SSR is a no-op that still returns an unsubscribe", () => {
    withWindow(undefined, () => {
      const unsubscribe = subscribeAutoMarkDone(() => {});

      expect(typeof unsubscribe).toBe("function");
      expect(() => unsubscribe()).not.toThrow();
    });
  });
});

describe("prefStore", () => {
  test("hands back window.localStorage in a normal browser", () => {
    const ls = fakeStore();

    withWindow({ localStorage: ls }, () => {
      expect(prefStore()).toBe(ls as unknown as PrefStore);
    });
  });

  test("returns null during SSR, where there is no window at all", () => {
    withWindow(undefined, () => {
      expect(prefStore()).toBeNull();
    });
  });

  test("returns null when merely reading window.localStorage throws", () => {
    // Some privacy settings throw on the property access itself, not on the
    // getItem/setItem call — the guard has to wrap the access.
    const hostileWindow = {
      get localStorage(): PrefStore {
        throw new Error("access denied");
      },
    };

    withWindow(hostileWindow, () => {
      expect(prefStore()).toBeNull();
    });
  });
});

describe("danmaku speed ladder", () => {
  test("every step survives the plugin's clamp", () => {
    // artplayer-plugin-danmuku does `clamp(this.option.speed, 1, 10)` inside
    // config(), and the slider then locates its handle with an exact
    // `findIndex(item => item.value === option.speed)`. A step outside [1, 10]
    // therefore does not render "a bit off" — it collapses onto whichever step
    // holds the clamped value and the handle lands on the wrong label. This is
    // measured behaviour: config({speed: 15}) reads back as 10.
    expect(speedLadderIsRenderable()).toBe(true);
    for (const { value } of DANMAKU_SPEED_STEPS) {
      expect(value).toBeGreaterThanOrEqual(DANMAKU_SPEED_MIN);
      expect(value).toBeLessThanOrEqual(DANMAKU_SPEED_MAX);
    }
  });

  test("rejects a ladder that would misbehave", () => {
    expect(speedLadderIsRenderable([{ value: 15 }])).toBe(false); // clamped
    expect(speedLadderIsRenderable([{ value: 0.5 }])).toBe(false); // clamped
    expect(speedLadderIsRenderable([{ value: 8 }, { value: 8 }])).toBe(false); // ambiguous
    expect(speedLadderIsRenderable([])).toBe(false);
  });

  test("the ladder runs slowest-first and the default is the slowest", () => {
    const values = DANMAKU_SPEED_STEPS.map((s) => s.value);
    // The slider renders steps left to right, and slow belongs on the left.
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThan(values[i - 1]);
    }
    expect(DANMAKU_SPEED_DEFAULT).toBe(values[0]);
    // Every tier is slower than the 5 the player used to hard-code — the
    // point of the change, and the thing a future edit is most likely to undo.
    for (const v of values) expect(v).toBeGreaterThan(5);
  });

  test("reads back a stored step", () => {
    const store = fakeStore({ [DANMAKU_SPEED_KEY]: "8" });
    expect(readDanmakuSpeed(store)).toBe(8);
  });

  test("a value that is not on the ladder falls back to the default", () => {
    // Everyone who played anything before this ladder existed has no stored
    // value at all; anyone mid-migration could hold the old hard-coded 5.
    // Neither has a slider position, so neither may be handed back.
    for (const raw of ["5", "7.5", "abc", ""]) {
      expect(readDanmakuSpeed(fakeStore({ [DANMAKU_SPEED_KEY]: raw }))).toBe(
        DANMAKU_SPEED_DEFAULT,
      );
    }
    expect(readDanmakuSpeed(fakeStore())).toBe(DANMAKU_SPEED_DEFAULT);
    expect(readDanmakuSpeed(null)).toBe(DANMAKU_SPEED_DEFAULT);
    expect(readDanmakuSpeed(throwingStore())).toBe(DANMAKU_SPEED_DEFAULT);
  });

  test("only writes values the slider can find again", () => {
    const store = fakeStore();
    expect(writeDanmakuSpeed(8, store)).toBe(true);
    expect(store.raw.get(DANMAKU_SPEED_KEY)).toBe("8");

    // The config event fires for opacity, margin, font size and the comment
    // list too, so this is called with whatever speed happens to be current.
    expect(writeDanmakuSpeed(15, store)).toBe(false);
    expect(writeDanmakuSpeed(5, store)).toBe(false);
    expect(store.raw.get(DANMAKU_SPEED_KEY)).toBe("8");
  });

  test("a failed write is reported, not swallowed", () => {
    expect(writeDanmakuSpeed(8, throwingStore())).toBe(false);
    expect(writeDanmakuSpeed(8, null)).toBe(false);
  });
});
