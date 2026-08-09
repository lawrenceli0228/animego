// Pure logic behind SubscriptionButton's toasts, split out so bun:test can
// exercise it without rendering the panel (next-app tests lib-style modules,
// not JSX — same split as torrentModalLogic.ts next door).

/** "This browser has already been shown where the list lives." */
export const LIST_HINT_KEY = "animego:subListHintShown";

/**
 * How long a subscribe toast that CARRIES AN ACTION stays up.
 *
 * The Toaster's global default is 3500ms (app/layout.tsx) — right for a toast
 * that only says "done", wrong for one whose whole purpose is that the reader
 * notices a link or an Undo and travels to it. On a phone the + lives at the
 * bottom of a grid and the toast appears top-center; 3500ms can expire while
 * the thumb is still moving, which is how the one-time /profile signpost got
 * marked as "shown" on a device that never actually showed it to anyone.
 *
 * Shared rather than per-call-site so the detail page and the grid cannot
 * drift apart on the answer to "how long do we give a user to act?".
 */
export const LIST_HINT_TOAST_MS = 7000;

/** The two methods we touch, so tests can pass a plain object. */
export interface HintStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * True exactly once per browser: the first successful subscribe carries a link
 * to /profile, every later one stays a plain confirmation.
 *
 * Deliberately NOT "does this user now have exactly one subscription" — that
 * answer costs a round trip, and this is onboarding copy rather than state, so
 * it does not need to be right, only cheap and non-repeating. Being wrong in
 * either direction is survivable: a cleared store re-arms the hint (one extra
 * toast on a device the user already knows), and the hint never fires twice on
 * the device where it mattered.
 *
 * A store that throws (Safari private mode, sandboxed iframe) suppresses the
 * hint instead of showing it — a hint we cannot mark as consumed would come
 * back on every single subscribe, which is worse than never showing it.
 */
export function takeListHint(store: HintStore | null): boolean {
  if (!store) return false;
  try {
    if (store.getItem(LIST_HINT_KEY)) return false;
    store.setItem(LIST_HINT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/**
 * localStorage when it is reachable. Touching `window.localStorage` is itself
 * throwing code under some privacy settings, so the guard has to wrap the
 * property access and not just the calls on it.
 */
export function hintStore(): HintStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
