import { describe, expect, test } from "bun:test";
import {
  createFolderWatcher,
  WATCH_DEBOUNCE_MS,
} from "./folderWatcher.js";

// Fake FileSystemObserver constructor: captures the records callback and the
// observed handles so tests can drive change records by hand.
function fakeObserverCtor() {
  const state = { callback: null, observed: [], disconnected: 0 };
  function Ctor(cb) {
    state.callback = cb;
    this.observe = async (handle, opts) => {
      state.observed.push({ handle, opts });
    };
    this.disconnect = () => {
      state.disconnected++;
    };
  }
  return { Ctor, state };
}

/** Manual timer harness: capture scheduled fns, fire on demand. */
function fakeTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    fire: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const t of pending) t.fn();
    },
    pending: () => timers.size,
  };
}

function harness() {
  const { Ctor, state } = fakeObserverCtor();
  const timers = fakeTimers();
  const changes = [];
  const rootErrors = [];
  const watcher = createFolderWatcher({
    onChange: () => changes.push(1),
    onRootError: (r) => rootErrors.push(r),
    ObserverCtor: Ctor,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { watcher, state, timers, changes, rootErrors };
}

describe("createFolderWatcher", () => {
  test("unsupported environment degrades to a no-op", async () => {
    const watcher = createFolderWatcher({ onChange: () => {} });
    expect(watcher.supported).toBe(false);
    await watcher.observe({}); // must not throw
    watcher.disconnect();
  });

  test("observes handles recursively", async () => {
    const { watcher, state } = harness();
    expect(watcher.supported).toBe(true);
    await watcher.observe({ tag: "root" });
    expect(state.observed).toHaveLength(1);
    expect(state.observed[0].opts).toEqual({ recursive: true });
  });

  test("change records debounce into a single onChange", async () => {
    const { watcher, state, timers, changes } = harness();
    await watcher.observe({});
    state.callback([{ type: "appeared" }]);
    state.callback([{ type: "modified" }]);
    state.callback([{ type: "moved" }]);
    expect(changes).toHaveLength(0);
    expect(timers.pending()).toBe(1);
    timers.fire();
    expect(changes).toHaveLength(1);
  });

  test("'unknown' (missed events) fires immediately and cancels the pending debounce", async () => {
    const { watcher, state, timers, changes } = harness();
    await watcher.observe({});
    state.callback([{ type: "appeared" }]);
    state.callback([{ type: "unknown" }]);
    expect(changes).toHaveLength(1);
    expect(timers.pending()).toBe(0);
  });

  test("'errored' routes to onRootError, not onChange", async () => {
    const { watcher, state, changes, rootErrors } = harness();
    await watcher.observe({});
    state.callback([{ type: "errored", root: { tag: "dead" } }]);
    expect(rootErrors).toHaveLength(1);
    expect(changes).toHaveLength(0);
  });

  test("disconnect cancels pending debounce and stops the observer", async () => {
    const { watcher, state, timers, changes } = harness();
    await watcher.observe({});
    state.callback([{ type: "appeared" }]);
    watcher.disconnect();
    expect(state.disconnected).toBe(1);
    timers.fire();
    expect(changes).toHaveLength(0);
  });

  test("observe failures degrade silently (unstandardized API)", async () => {
    const { Ctor, state } = fakeObserverCtor();
    const watcher = createFolderWatcher({
      onChange: () => {},
      ObserverCtor: function BadCtor(cb) {
        state.callback = cb;
        this.observe = async () => {
          throw new Error("shape changed");
        };
        this.disconnect = () => {};
      },
    });
    await watcher.observe({}); // must not throw
    expect(watcher.supported).toBe(true);
    void Ctor;
  });

  test("default debounce constant is sane (10s)", () => {
    expect(WATCH_DEBOUNCE_MS).toBe(10_000);
  });
});
