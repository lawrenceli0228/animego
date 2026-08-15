/**
 * Player preferences that live on the device, not on the server.
 *
 * Today that is one switch: `autoMarkDone`. When it is on, the player marks an
 * episode watched once playback crosses the completion threshold and pushes
 * the watch progress up (design doc §4 decision 6 / §5.1 — ported from
 * Animeko's `VideoScaffoldConfig.autoMarkDone: Boolean = true`, which is on by
 * default there too). Some people would rather tick episodes off themselves,
 * so it has to be switchable.
 *
 * Read it at the moment you need the answer — it is a synchronous
 * `localStorage.getItem`, so caching it in a ref buys nothing and costs you
 * correctness: a fresh read picks up a change made in the settings tab while
 * the player tab stayed open. React components that need to *render* the value
 * should feed `subscribeAutoMarkDone` + `readAutoMarkDone` to
 * `useSyncExternalStore` instead.
 *
 * SSR-safe: nothing here touches `window` at module scope, and every function
 * degrades to the default when there is no reachable storage, so a server
 * component may import this module and a client component may call it
 * unconditionally.
 */

/**
 * Namespaced the same way as every other player preference
 * (`animego:playbackRate`, `animego:danmakuVisible` — VideoPlayer.tsx).
 *
 * Renaming this silently re-enables the feature for everyone who had turned it
 * off, because an unknown key reads as the default. Treat it as permanent.
 */
export const AUTO_MARK_DONE_KEY = "animego:autoMarkDone";

/** Never set = on. Matches Animeko's default. */
export const AUTO_MARK_DONE_DEFAULT = true;

/** The two localStorage methods we touch, so tests can pass a plain object. */
export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * localStorage when it is reachable, otherwise null.
 *
 * Reading `window.localStorage` is itself throwing code under some privacy
 * settings, so the guard wraps the property access and not just the calls on
 * it (same shape as `hintStore()` in components/anime/subscriptionToast.ts).
 */
export function prefStore(): PrefStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Custom event name, mirroring `animego:langchange` in lib/lang-client.tsx —
 * the browser's own `storage` event only fires in the *other* tabs, so a
 * same-tab change needs its own signal.
 */
const CHANGE_EVENT = "animego:automarkdonechange";

function announce(): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Is auto-marking on? Falls back to the default whenever the answer cannot be
 * trusted — no storage (SSR, private mode, storage disabled), never written,
 * or a value we did not write.
 *
 * A corrupt value must NOT read as "off": this is an opt-out switch, and
 * silently disabling a feature the user never turned off is the worse of the
 * two failure directions.
 */
export function readAutoMarkDone(store: PrefStore | null = prefStore()): boolean {
  if (!store) return AUTO_MARK_DONE_DEFAULT;
  try {
    const raw = store.getItem(AUTO_MARK_DONE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return AUTO_MARK_DONE_DEFAULT;
  } catch {
    return AUTO_MARK_DONE_DEFAULT;
  }
}

/**
 * Persist the switch. Returns whether it actually landed.
 *
 * The return value is the point. `VideoPlayer.tsx:172-175` writes preferences
 * inside a catch block whose whole body is the word "ignore", so on a full or
 * disabled store the user flips a switch, sees it flip, and nothing changes —
 * design doc §9 CG1 names that as the habit to stop repeating. Callers must
 * surface a `false`; since a failed write means every reader keeps seeing the
 * old value, the UI also has to keep showing the old value rather than the
 * requested one.
 *
 * A successful write announces itself so `subscribeAutoMarkDone` listeners in
 * this tab re-read. Other tabs get the browser's own `storage` event.
 */
export function writeAutoMarkDone(
  value: boolean,
  store: PrefStore | null = prefStore(),
): boolean {
  if (!store) return false;
  try {
    store.setItem(AUTO_MARK_DONE_KEY, value ? "1" : "0");
  } catch {
    return false;
  }
  announce();
  return true;
}

/**
 * Watch the switch. Returns the unsubscribe function, so it drops straight
 * into `useSyncExternalStore(subscribeAutoMarkDone, readAutoMarkDone, …)` —
 * the same shape the /library hooks already use, and the one API that lets a
 * component read a browser-only value without a hydration mismatch or a
 * setState-in-effect.
 *
 * Fires for both a change made here and one made in another tab.
 */
export function subscribeAutoMarkDone(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
