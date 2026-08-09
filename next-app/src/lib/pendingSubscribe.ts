// Carries a "I meant to track this anime" intent across the login round trip.
//
// The quick-subscribe button on a poster card is the first write a visitor
// ever wants to make, and most visitors are anonymous when they press it.
// Sending them to /login and dropping the intent on the floor is how the
// funnel leaks: they come back to the grid, the card looks identical to
// before, and they have to find the same poster and press + a second time.
//
// So the button stashes the anilistId here, /login?from=… bounces the user
// back to the exact grid, and SubscriptionSetProvider replays the write once
// its list load proves the session is real.
//
// sessionStorage (not localStorage) on purpose: the intent belongs to *this*
// tab and *this* visit. A localStorage stash survives browser restarts, and
// a stale one would silently add an anime days later — the user would open
// their list and find a show they never confirmed.
//
// Every access is wrapped: Safari private mode and "block all cookies" both
// make `window.sessionStorage` throw on property access, not just on write.
// A thrown storage error must never break the button — losing the intent is
// a mild annoyance, an exception on click is a dead control.
//
// ---------------------------------------------------------------------------
// The intent is bound to ONE login round trip, not to "the next session that
// happens to appear"
// ---------------------------------------------------------------------------
//
// A stash that only says "somebody wanted anime 189046" is a write looking for
// an account. Two ways that goes wrong, both observed in review:
//
//   1. Shared machine. Visitor A presses + on /seasonal, sees the register
//      form, walks away. The tab sits on /login. Visitor B sits down, logs in
//      with their own account, gets bounced to /seasonal — and B's list now
//      contains a show B never touched.
//
//   2. Single user, later errand. Same abandoned stash, but the user logs in
//      from the navbar half an hour later and lands on the home page. The
//      write fires there too, with no poster on screen to explain it.
//
// So the record carries the path it was created on, and the replay only fires
// when the browser is standing on that same path. That is exactly the shape of
// the round trip we designed for (+ → /login?from=<path> → back to <path>), so
// the intended flow is unaffected while case 2 is closed outright. Case 1 is a
// heuristic — B *is* redirected back to A's page — so the TTL below is the
// second belt, and the provider clears the stash the moment it settles on an
// anonymous viewer.
//
// The comparison is on pathname alone, deliberately. The query string is what
// changes between "press + on /search?q=naruto" and any subsequent navigation,
// and a mismatch there does not mean a different user — only a different view
// of the same page.

/**
 * How long a stashed intent stays valid.
 *
 * Sized to the longest honest version of the round trip — press +, land on
 * /login, hop to /register, type an email and a password, submit — and no
 * further. It used to be ten minutes, which is comfortably long enough for
 * somebody else to sit down at the same machine and inherit the write.
 *
 * The two costs are wildly asymmetric, so this errs short. Too long: a write
 * appears in a stranger's account. Too short: the visitor arrives to find the
 * card still showing +, and taps it once — except now they are signed in, so
 * it lands instantly and with a confirmation. One recoverable tap against one
 * unrecoverable write into the wrong list.
 */
export const PENDING_TTL_MS = 3 * 60 * 1000;

const STORAGE_KEY = "animego:pendingSubscribe";

interface PendingRecord {
  anilistId: number;
  ts: number;
  /** The pathname the + was pressed on. Replay is refused anywhere else. */
  path: string;
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage ?? null;
  } catch {
    // Property access itself throws when storage is blocked by policy.
    return null;
  }
}

/**
 * Canonical form of a pathname for comparison.
 *
 * Trailing slashes are the only drift we expect between the URL a card was
 * clicked on and the URL the login redirect lands on (Next normalises some
 * routes, and a hand-typed `from` may not), and a bare `""` — which only
 * happens in a non-browser environment — collapses to root rather than
 * becoming a value that matches nothing.
 */
export function normalizePath(path: string): string {
  if (!path) return "/";
  const trimmed =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed || "/";
}

/** The pathname we are standing on right now, normalised; "/" when unknowable. */
export function currentPath(): string {
  try {
    if (typeof window === "undefined") return "/";
    return normalizePath(window.location?.pathname ?? "");
  } catch {
    return "/";
  }
}

/**
 * Parse a raw storage value into a still-valid anilistId.
 *
 * Exported for the test suite: this is where every hostile shape lands
 * (hand-edited storage, a record written by an older build, a clock that
 * jumped backwards) and it must degrade to `null` rather than throw.
 *
 * @param path where the browser is now — the record is only honoured if it
 *   was created on the same pathname.
 */
export function decodePendingSubscribe(
  raw: string | null,
  now: number,
  path: string,
): number | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { anilistId, ts, path: from } = parsed as Partial<PendingRecord>;
  if (typeof anilistId !== "number" || !Number.isInteger(anilistId)) return null;
  if (anilistId < 1) return null;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  // A record with no path is either hand-written or left over from the build
  // that shipped before this binding existed. Unbindable, so unusable — one
  // deploy's worth of abandoned intents is the entire cost.
  if (typeof from !== "string" || from === "") return null;
  if (normalizePath(from) !== normalizePath(path)) return null;
  // `now - ts` negative means the record claims to be from the future — a
  // clock adjustment mid-session. Treat it as valid rather than expired:
  // the user pressed + moments ago, and punishing them for a system clock
  // change is worse than honouring a slightly odd timestamp.
  if (now - ts > PENDING_TTL_MS) return null;
  return anilistId;
}

/** Serialise an intent. Exported alongside the decoder so tests can round-trip. */
export function encodePendingSubscribe(
  anilistId: number,
  now: number,
  path: string,
): string {
  return JSON.stringify({
    anilistId,
    ts: now,
    path: normalizePath(path),
  } satisfies PendingRecord);
}

/**
 * Remember that the visitor wanted to track `anilistId` before they were
 * bounced to /login. Silently does nothing when storage is unavailable.
 *
 * The current pathname is captured here rather than passed in so the one
 * caller (QuickSubscribeToggle) cannot forget it, and so the value that gets
 * stored is always the one the browser actually reports.
 */
export function stashPendingSubscribe(anilistId: number): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      STORAGE_KEY,
      encodePendingSubscribe(anilistId, Date.now(), currentPath()),
    );
  } catch {
    // Quota exceeded / private mode. The intent is lost; the button still works.
  }
}

/**
 * Read the stashed intent and clear it in the same breath.
 *
 * Read-and-clear (rather than read-then-clear-on-success) is deliberate: if
 * the replay write fails, we do NOT want it retried on every subsequent page
 * the provider mounts on. One shot, then the user is back in control. Note
 * that a *path mismatch* also consumes the record — an intent that surfaced on
 * the wrong page has already proven it cannot be trusted, so it must not
 * survive to ambush a later navigation that happens to match.
 *
 * @returns the anilistId, or null when there is none / it expired / it belongs
 *   to another page / storage is unreadable.
 */
export function takePendingSubscribe(): number | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
    store.removeItem(STORAGE_KEY);
  } catch {
    return null;
  }
  return decodePendingSubscribe(raw, Date.now(), currentPath());
}

/**
 * Drop any stashed intent without reading it.
 *
 * Called when the provider learns there is no session to write into — on a
 * settled-anonymous load, and on sign-out. Both mean the same thing: whoever
 * pressed + is not the person who will be here next, and a write held in
 * escrow for them is a write in somebody else's account.
 */
export function clearPendingSubscribe(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — an unwritable store is also one we never wrote to.
  }
}
