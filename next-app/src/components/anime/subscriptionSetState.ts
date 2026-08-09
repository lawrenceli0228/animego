// Pure state for the subscription set — no React, no DOM, no toast.
//
// Split out of SubscriptionSetProvider because the test for these reducers was
// passing locally for the wrong reason. bun:test shares one process across
// files, so an earlier suite happened to leave a `document` global behind and
// importing the provider — which pulls react-hot-toast, which pulls goober,
// which touches `document` at module-evaluation time — worked by accident. CI
// ordered the files differently and the whole 37-test suite aborted with
// `ReferenceError: document is not defined` before its first assertion.
//
// Nothing here evaluates any DOM at import time. `window` is touched only
// inside the sign-out helpers, behind a typeof guard, at call time. That makes
// the tests honest: they exercise this module and nothing else, and no import
// order can turn them green or red.

import type { SubscriptionDoc } from "@/lib/subscriptionBus";

export interface SubscriptionSetApi {
  /** The provider has settled — either the set loaded, or the viewer is anonymous. */
  ready: boolean;
  /** Signed in AND the set is in hand. false = anonymous / still loading / no provider. */
  known: boolean;
  has(anilistId: number): boolean;
  add(anilistId: number): Promise<boolean>;
  remove(anilistId: number): Promise<boolean>;
}

export interface SubscriptionSetState {
  ready: boolean;
  known: boolean;
  ids: ReadonlySet<number>;
}

const EMPTY_IDS: ReadonlySet<number> = new Set<number>();

export const LOADING: SubscriptionSetState = {
  ready: false,
  known: false,
  ids: EMPTY_IDS,
};

/**
 * Nobody is signed in — the state a page starts from for a visitor with no
 * `auth_hint`, and the state it must return to the instant one signs out.
 *
 * Exported so the sign-out reset is assertable without a renderer. The
 * load-bearing part is that it carries an EMPTY id set: dropping `known` alone
 * would hide the ✓s while the previous account's ids sat in memory, one stray
 * `known` flip away from painting them back onto a stranger's screen.
 */
export const ANONYMOUS_STATE: SubscriptionSetState = {
  ready: true,
  known: false,
  ids: EMPTY_IDS,
};

/**
 * What a card gets when nobody wrapped the tree. Not an error state: the
 * toggle renders its signed-out affordance and the click still routes to
 * /login, so a page that forgets the provider degrades to "works, just never
 * shows ✓" instead of throwing during render.
 *
 * Exported so the contract is assertable without a renderer — useSubscriptionSet
 * itself cannot be called outside a component tree.
 */
export const SUBSCRIPTION_SET_FALLBACK: SubscriptionSetApi = {
  ready: true,
  known: false,
  has: () => false,
  add: async () => false,
  remove: async () => false,
};


// The status a quick-add writes. The card UI has no status picker by design —
// "+" means "I'm watching this", and anything more nuanced belongs on the
// detail page where the full panel lives.
export const QUICK_ADD_STATUS = "watching" as const;

// ---------------------------------------------------------------------------
// Sign-out signal
// ---------------------------------------------------------------------------
//
// Logging out is a client-side state change with no navigation attached:
// Navbar POSTs /api/auth/logout, go-api clears the cookies, the nav bar swaps
// to "登录 / 注册" — and the page underneath does not move. On a grid that
// leaves every poster the previous user was tracking wearing a ✓, on a page
// that visibly says nobody is signed in, until something happens to trigger a
// route change. On a shared machine the next person reads the first person's
// watchlist off the screen.
//
// The provider cannot detect this on its own. `auth_hint` is a cookie, and
// cookies do not emit events; polling document.cookie to find out whether the
// person in front of the screen is still the same person is not a design. So
// the surface that performs the logout announces it, and everything holding
// per-account state listens.
//
// A window CustomEvent rather than context: the emitter (Navbar, in the root
// layout) is an ancestor of every provider on the page, and it must also reach
// providers mounted in sibling subtrees — TrendingSection's, the seasonal
// grid's — without any of them being wired to it.

/** Fired after a logout request settles. Detail-free: the event IS the news. */
export const SIGNED_OUT_EVENT = "animego:auth:signed-out";

/**
 * Tell every account-scoped view on the page that the session is gone.
 *
 * Call it from the logout handler *after* the request settles, success or
 * not — go-api clears the cookies either way, so the UI must stop showing
 * account state either way.
 */
export function broadcastSignedOut(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
}

/** Subscribe to {@link SIGNED_OUT_EVENT}. Returns the unsubscribe function. */
export function subscribeToSignedOut(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SIGNED_OUT_EVENT, handler);
  return () => window.removeEventListener(SIGNED_OUT_EVENT, handler);
}

// ---------------------------------------------------------------------------
// Pure reducers — everything below is straight data in / data out so the
// interesting behaviour (envelope parsing, optimistic rollback) is testable
// without rendering anything.
// ---------------------------------------------------------------------------

/**
 * Reduce a `GET /api/subscriptions` body into the id set.
 *
 * Tolerant on purpose. The endpoint answers `{data:[…]}`, but this also
 * survives a bare array, a null envelope, and rows whose anilistId is missing
 * or non-numeric — a malformed row must cost us that one card's ✓, not the
 * whole grid.
 */
export function subscribedIdsFromList(body: unknown): ReadonlySet<number> {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : [];

  const ids = new Set<number>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = (row as { anilistId?: unknown }).anilistId;
    if (typeof id === "number" && Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

/**
 * Add or drop one id, returning the SAME set reference when nothing changed.
 *
 * Reference stability matters more than it looks: every bus echo of our own
 * write lands here, and a fresh Set each time would re-render all 20+ cards
 * for a no-op.
 */
export function applySubscriptionChange(
  current: ReadonlySet<number>,
  anilistId: number,
  subscribed: boolean,
): ReadonlySet<number> {
  if (current.has(anilistId) === subscribed) return current;
  const next = new Set(current);
  if (subscribed) next.add(anilistId);
  else next.delete(anilistId);
  return next;
}

export type WriteIntent = "add" | "remove";
/** `optimistic` = paint it now; `confirmed` = server agreed; `reverted` = undo. */
export type WriteOutcome = "optimistic" | "confirmed" | "reverted";

/**
 * The whole optimistic-write lifecycle as one function: current set + what the
 * user asked for + how it went → next set.
 *
 * Rollback is expressed as "apply the inverse of the intent" rather than
 * "restore a snapshot" because the caller only ever issues a write when the
 * card is not already busy, so the inverse is exactly the pre-write value.
 */
export function nextSubscriptionSet(
  current: ReadonlySet<number>,
  anilistId: number,
  intent: WriteIntent,
  outcome: WriteOutcome,
): ReadonlySet<number> {
  const wanted = intent === "add";
  return applySubscriptionChange(
    current,
    anilistId,
    outcome === "reverted" ? !wanted : wanted,
  );
}

/**
 * Swap the id set on a state object, preserving the object identity when the
 * set did not actually change. Pairs with applySubscriptionChange's reference
 * stability so a no-op write costs zero re-renders across the grid.
 */
export function withIds(prev: SubscriptionSetState, ids: ReadonlySet<number>): SubscriptionSetState {
  return ids === prev.ids ? prev : { ...prev, ids };
}

/** How a write response should be acted on. */
export type WriteVerdict = "success" | "signedOut" | "failed";

/**
 * Classify `POST /api/subscriptions`.
 *
 * 401 is its own verdict, not a failure: it means the session died between the
 * list load and the click, so the honest response is to drop the whole grid to
 * signed-out rather than roll one card back and leave the rest lying.
 */
export function classifyCreateStatus(status: number): WriteVerdict {
  if (status >= 200 && status < 300) return "success";
  if (status === 401) return "signedOut";
  // 404 from a CREATE is a real failure — go-api answers it when the anilistId
  // is not in anime_cache and AniList could not be reached to fill it. There is
  // no row, so painting a ✓ would be a lie. Contrast the DELETE case below.
  return "failed";
}

/**
 * Classify `DELETE /api/subscriptions/:id`.
 *
 * 404 counts as SUCCESS. DELETE is idempotent and "the row is not there" is
 * precisely the state the caller asked for — somebody just got there first
 * (the other tab, the detail page, a double click). Treating it as a failure
 * produced a card that could never be fixed: the rollback repainted the ✓ off
 * a set that had been stale since page load, the next click 404'd for the same
 * reason, and only a reload broke the loop.
 */
export function classifyDeleteStatus(status: number): WriteVerdict {
  if (status >= 200 && status < 300) return "success";
  if (status === 404) return "success";
  if (status === 401) return "signedOut";
  return "failed";
}

/** Narrow a create/patch response body into a bus-shaped doc. */
export function docFromResponse(body: unknown): SubscriptionDoc {
  const data =
    body && typeof body === "object"
      ? ((body as { data?: unknown }).data as Partial<SubscriptionDoc> | null)
      : null;
  return {
    status: data?.status ?? QUICK_ADD_STATUS,
    currentEpisode:
      typeof data?.currentEpisode === "number" ? data.currentEpisode : 0,
    score: typeof data?.score === "number" ? data.score : null,
  };
}
