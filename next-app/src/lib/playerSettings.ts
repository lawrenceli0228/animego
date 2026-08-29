/**
 * Player preferences that live on the device, not on the server.
 *
 * Two of them so far: `autoMarkDone` and the danmaku speed ladder.
 *
 * `autoMarkDone` — when it is on, the player marks an
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

/* ── Danmaku speed ─────────────────────────────────────────────────────── */

/** Same namespace as the rest (`animego:playbackRate`, `animego:danmakuVisible`). */
export const DANMAKU_SPEED_KEY = "animego:danmakuSpeed";

/**
 * How long a comment takes to cross the screen, in seconds. Bigger is slower.
 *
 * THE CEILING IS 10 AND IT IS NOT OURS. artplayer-plugin-danmuku clamps inside
 * `config()`:
 *
 *     this.option.speed = clamp(this.option.speed, 1, 10);
 *
 * so a step of 15 does not render slowly — it silently becomes 10. Measured,
 * not assumed: `config({speed: 15})` and `config({speed: 12})` both read back
 * as 10. That failure is invisible from the UI in the worst possible way,
 * because the slider finds its position by matching `option.speed` against
 * these values (`SPEED.steps.findIndex(item => item.value === option.speed)`)
 * — an out-of-range step would collapse onto whichever step holds 10 and the
 * handle would jump to the wrong label. `speedLadderIsRenderable()` pins it.
 *
 * The ladder deliberately sits at the slow end: the fastest tier here (6.5) is
 * still slower than the 5 the player used to hard-code, because dense comment
 * streams at 5s are the thing that made them unreadable.
 */
export const DANMAKU_SPEED_STEPS: ReadonlyArray<{ name: string; value: number }> = [
  { name: "极慢", value: 10 },
  { name: "缓慢", value: 8 },
  { name: "适中", value: 6.5 },
];

/** The slowest tier. Deliberately the default — see DANMAKU_SPEED_STEPS. */
export const DANMAKU_SPEED_DEFAULT = DANMAKU_SPEED_STEPS[0].value;

/** The bounds the plugin enforces; exported so the guard test can name them. */
export const DANMAKU_SPEED_MIN = 1;
export const DANMAKU_SPEED_MAX = 10;

/**
 * Would every step survive the plugin's clamp and stay findable on the slider?
 *
 * Exists so the ladder cannot be edited into a shape that looks fine in the
 * source and misbehaves only once a comment is on screen.
 */
export function speedLadderIsRenderable(
  steps: ReadonlyArray<{ value: number }> = DANMAKU_SPEED_STEPS,
): boolean {
  const seen = new Set<number>();
  for (const { value } of steps) {
    if (!Number.isFinite(value)) return false;
    if (value < DANMAKU_SPEED_MIN || value > DANMAKU_SPEED_MAX) return false;
    if (seen.has(value)) return false;
    seen.add(value);
  }
  return steps.length > 0;
}

/**
 * The stored speed, snapped to a step we actually offer.
 *
 * Snapping rather than clamping is the point: the slider locates the handle by
 * exact equality against the step values, so a stored 5 — which every user who
 * played anything before this ladder existed has — is not "a bit fast", it is
 * *no position at all* (`findIndex` returns -1). Falling back to the default
 * puts the handle somewhere real.
 */
export function readDanmakuSpeed(store: PrefStore | null = prefStore()): number {
  if (!store) return DANMAKU_SPEED_DEFAULT;
  try {
    const raw = Number(store.getItem(DANMAKU_SPEED_KEY));
    if (!Number.isFinite(raw)) return DANMAKU_SPEED_DEFAULT;
    return DANMAKU_SPEED_STEPS.some((s) => s.value === raw)
      ? raw
      : DANMAKU_SPEED_DEFAULT;
  } catch {
    return DANMAKU_SPEED_DEFAULT;
  }
}

/**
 * Persist the speed. Returns whether it landed, for the same reason
 * `writeAutoMarkDone` does.
 *
 * A value outside the ladder is refused rather than written: the plugin's
 * `artplayerPluginDanmuku:config` event fires for every config change it makes
 * — opacity, margin, font size, the comment list we hand it on each episode —
 * so this is called with whatever `option.speed` happens to be, and writing an
 * unknown value would mean `readDanmakuSpeed` discards it next time anyway.
 */
export function writeDanmakuSpeed(
  value: number,
  store: PrefStore | null = prefStore(),
): boolean {
  if (!store) return false;
  if (!DANMAKU_SPEED_STEPS.some((s) => s.value === value)) return false;
  try {
    store.setItem(DANMAKU_SPEED_KEY, String(value));
  } catch {
    return false;
  }
  return true;
}
