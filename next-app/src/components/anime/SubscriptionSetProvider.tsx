"use client";

// One subscription-set load per page, shared by every poster card on it.
//
// The obvious implementation of "put a + on each card" is to give each card
// the SubscriptionButton treatment: probe GET /api/subscriptions/:id on mount.
// That is fine for the detail page, which renders exactly one. A seasonal or
// search grid renders 20+ above the fold, and 20+ probes leaving the browser
// at once is precisely the shape that took the site down in 2026-06 — go-api's
// per-IP limiter sees the whole grid as one caller, 429s the tail, and the
// failures surface as broken UI. So the grid gets ONE request:
//
//   GET /api/subscriptions  →  Set<anilistId>
//
// and every card reads from context. The set is small (the p50 user has one
// subscription; the p99 has tens) so holding the whole thing in memory is
// cheaper than any per-card cache would be.
//
// Anonymous visitors cost zero requests: hasAuthHint() reads the non-httpOnly
// `auth_hint` cookie and short-circuits before the fetch. A 401 despite the
// hint (rotated-out session) also settles to anonymous without a retry —
// authFetch already made one refresh attempt on our behalf.
//
// Sync with the detail page runs both ways over subscriptionBus: we apply
// what SubscriptionButton broadcasts, and we broadcast our own writes so a
// detail page opened later in the same session paints the right state.

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type SetStateAction,
} from "react";
import toast, { type Toast } from "react-hot-toast";
import { authFetch } from "@/lib/authFetch";
import { hasAuthHint } from "@/lib/clientAuth";
import { useLang } from "@/lib/lang-client";
import {
  clearPendingSubscribe,
  takePendingSubscribe,
} from "@/lib/pendingSubscribe";
import {
  broadcastSubscription,
  subscribeToBus,
  type SubscriptionDoc,
} from "@/lib/subscriptionBus";
import {
  LIST_HINT_TOAST_MS,
  hintStore,
  takeListHint,
} from "./subscriptionToast";

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

const LOADING: SubscriptionSetState = {
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

const SubscriptionSetContext = createContext<SubscriptionSetApi | null>(null);

// The status a quick-add writes. The card UI has no status picker by design —
// "+" means "I'm watching this", and anything more nuanced belongs on the
// detail page where the full panel lives.
const QUICK_ADD_STATUS = "watching" as const;

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
function withIds(prev: SubscriptionSetState, ids: ReadonlySet<number>): SubscriptionSetState {
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
function docFromResponse(body: unknown): SubscriptionDoc {
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

// ---------------------------------------------------------------------------
// Shared confirmation toast
// ---------------------------------------------------------------------------

const toastRowStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
};

const toastLinkStyle: CSSProperties = {
  color: "#0a84ff",
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

/**
 * The confirmation shown when a stashed intent is replayed after login.
 *
 * The reason this is not just `toast.success(t("sub.toastAdded"))`: the
 * one-time "查看我的追番" signpost is spent by whichever surface subscribes
 * first, and the replay path used to be the one surface that could not spend
 * it — it fired a bare confirmation and left the hint armed for some later
 * click. That is backwards. The person on this path pressed + as an anonymous
 * visitor, went through registration, and came back; they have exactly one
 * subscription and the least idea of anywhere on this site their list might
 * live. If any single moment deserves the signpost, it is this one.
 *
 * Deliberately WITHOUT the Undo action that a poster click's toast carries.
 * Undo compensates a mis-tap, and nothing was tapped on this page — the write
 * is the redemption of an intent the visitor formed minutes ago and then spent
 * a whole registration flow confirming. The route out is the card's ✓, which
 * leads to the detail page and its full panel.
 */
export function showReplayAddedToast(t: (key: string) => string): void {
  if (!takeListHint(hintStore())) {
    toast.success(t("sub.toastAdded"));
    return;
  }
  toast.success(
    (instance: Toast) => (
      <span style={toastRowStyle}>
        {t("sub.toastAdded")}
        <Link
          href="/profile"
          prefetch={false}
          style={toastLinkStyle}
          onClick={() => toast.dismiss(instance.id)}
        >
          {t("sub.toastViewList")}
        </Link>
      </span>
    ),
    // Same budget the click path gives its actionable toast. A toast whose
    // point is that the reader travels somewhere cannot use the Toaster's
    // 3500ms "done" default — and this one appears while the eyes are still
    // re-orienting after a full page navigation back from /login.
    { duration: LIST_HINT_TOAST_MS },
  );
}

// ---------------------------------------------------------------------------

export function SubscriptionSetProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useLang();
  // A nested provider passes the ancestor's value straight through and never
  // fetches. The entire point of this component is that a page makes ONE list
  // request, and "someone wrapped a section that was already wrapped" is
  // exactly how that guarantee erodes without anyone noticing.
  const outer = useContext(SubscriptionSetContext);
  // Starts "loading" on both sides of hydration: the server cannot read the
  // hint cookie (these grids are cached), so an SSR render that guessed
  // "signed in" would mismatch. The mount effect is the only thing that
  // decides.
  const [state, setState] = useState<SubscriptionSetState>(LOADING);

  // Latched by the sign-out listener below. Everything that paints account
  // state routes through `commit` and is dropped once this is set: the list
  // load and any in-flight write were issued on behalf of an account that has
  // since left, and letting their results land would repaint the ✓s we just
  // cleared. The latch is per-mount, so signing back in — which always goes
  // through /login, i.e. a route change — starts from a fresh provider.
  const signedOut = useRef(false);
  // Guards the one-shot pending-intent replay further down. Declared up here
  // with its sibling latch because the sign-out listener closes it too.
  const replayed = useRef(false);
  const commit = useCallback((next: SetStateAction<SubscriptionSetState>) => {
    if (signedOut.current) return;
    setState(next);
  }, []);

  useEffect(() => {
    if (outer) return undefined;
    return subscribeToSignedOut(() => {
      signedOut.current = true;
      // Straight to setState, bypassing `commit` — this is the one write that
      // must land after the latch closes.
      setState(ANONYMOUS_STATE);
      // The person who stashed an intent is, by definition, not the person who
      // will be here next. Replaying it after the next login writes into a
      // stranger's list.
      clearPendingSubscribe();
      // Belt to the stash's braces: even if `known` somehow came back within
      // this mount, nothing is left to replay.
      replayed.current = true;
    });
  }, [outer]);

  useEffect(() => {
    if (outer) return;
    let cancelled = false;
    // Every setState below lives inside the async helper, never in the effect
    // body — including the no-hint short-circuit, which is otherwise the one
    // synchronous path. That is what react-hooks/set-state-in-effect forbids,
    // and Navbar's auth probe already settles the same way for the same reason.
    // A microtask's delay costs nothing here: the toggle renders null until
    // `ready`, and it is absolutely positioned, so arriving a tick later shifts
    // no layout.
    //
    // Settling anonymous also drops any stashed intent. There is no session to
    // replay it into, and an intent left in the jar is one that fires on
    // whoever signs in next — which on a shared browser is not necessarily the
    // person who pressed +. Safe against the happy path by ordering: this runs
    // on mount, and the + that writes a stash can only be pressed afterwards.
    const settleAnonymous = () => {
      commit(ANONYMOUS_STATE);
      clearPendingSubscribe();
    };
    const resolve = async () => {
      if (!hasAuthHint()) {
        if (!cancelled) settleAnonymous();
        return;
      }
      try {
        const res = await authFetch("/api/subscriptions", {
          skipRedirectOnFailure: true,
        });
        if (cancelled) return;
        if (!res.ok) {
          // 401 (hint outlived the session) and 5xx alike: settle anonymous.
          // No retry — a grid that hammers a struggling API is the failure
          // mode this provider exists to prevent.
          settleAnonymous();
          return;
        }
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        commit({ ready: true, known: true, ids: subscribedIdsFromList(body) });
      } catch {
        if (!cancelled) settleAnonymous();
      }
    };
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [outer, commit]);

  // Mirror detail-page writes. Only meaningful once we know the set — before
  // that, the load itself will pick up whatever the detail page did.
  useEffect(
    () =>
      outer
        ? undefined
        : subscribeToBus(({ anilistId, sub }) => {
            commit((prev) =>
              prev.known
                ? withIds(prev, applySubscriptionChange(prev.ids, anilistId, sub != null))
                : prev,
            );
          }),
    [outer, commit],
  );

  const add = useCallback(
    async (anilistId: number): Promise<boolean> => {
      commit((prev) =>
        withIds(prev, nextSubscriptionSet(prev.ids, anilistId, "add", "optimistic")),
      );
      try {
        const res = await authFetch("/api/subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anilistId, status: QUICK_ADD_STATUS }),
          skipRedirectOnFailure: true,
        });
        const verdict = classifyCreateStatus(res.status);
        if (verdict === "success") {
          const doc = docFromResponse(await res.json().catch(() => null));
          commit((prev) =>
            withIds(prev, nextSubscriptionSet(prev.ids, anilistId, "add", "confirmed")),
          );
          broadcastSubscription({ anilistId, sub: doc });
          return true;
        }
        // The session died between load and click. Drop to anonymous so every
        // card re-renders as a login CTA rather than lying with a ✓ the server
        // never stored.
        if (verdict === "signedOut") {
          commit(ANONYMOUS_STATE);
          return false;
        }
      } catch {
        /* network failure — falls through to the revert below */
      }
      commit((prev) =>
        withIds(prev, nextSubscriptionSet(prev.ids, anilistId, "add", "reverted")),
      );
      return false;
    },
    [commit],
  );

  const remove = useCallback(
    async (anilistId: number): Promise<boolean> => {
      commit((prev) =>
        withIds(prev, nextSubscriptionSet(prev.ids, anilistId, "remove", "optimistic")),
      );
      try {
        const res = await authFetch(`/api/subscriptions/${anilistId}`, {
          method: "DELETE",
          skipRedirectOnFailure: true,
        });
        // Note classifyDeleteStatus folds 404 into "success" — see there.
        const verdict = classifyDeleteStatus(res.status);
        if (verdict === "success") {
          // The optimistic paint already dropped the id, so this only has to
          // tell the rest of the page. Broadcasting on the 404 path matters
          // most of all: that is the case where some other surface still
          // believes the subscription exists.
          broadcastSubscription({ anilistId, sub: null });
          return true;
        }
        if (verdict === "signedOut") {
          commit(ANONYMOUS_STATE);
          return false;
        }
      } catch {
        /* network failure — falls through to the revert below */
      }
      commit((prev) =>
        withIds(prev, nextSubscriptionSet(prev.ids, anilistId, "remove", "reverted")),
      );
      return false;
    },
    [commit],
  );

  // Replay the intent a signed-out visitor stashed before we bounced them to
  // /login. Gated on `known` so we never fire the write against a session that
  // does not exist; guarded by a ref so a re-render (or a second set update)
  // cannot double-write. takePendingSubscribe clears on read — and only hands
  // the intent back on the page it was created on — so even two providers
  // mounted at once can only produce one write, on the right page.
  useEffect(() => {
    if (outer || !state.known || replayed.current) return;
    replayed.current = true;
    const pending = takePendingSubscribe();
    if (pending == null) return;
    // Already tracked (they logged into an account that has it). The intent is
    // satisfied and the card is about to paint ✓ on its own; a toast claiming
    // we just added it would be a small lie about a write we never made.
    if (state.ids.has(pending)) return;
    void (async () => {
      // This write is invisible — no button was pressed on this page, so
      // nothing here is spinning and nothing goes grey on failure. Without a
      // toast the whole round trip ends in silence: the intent has been
      // consumed, the card still shows +, and the user is left deciding
      // whether the login failed or the feature is broken. Both outcomes have
      // to say something.
      const ok = await add(pending);
      // …unless the user signed out while it was in flight, in which case both
      // messages are about an account that is no longer on screen.
      if (signedOut.current) return;
      if (ok) showReplayAddedToast(t);
      else toast.error(t("card.quickAddFail"));
    })();
  }, [outer, state.known, state.ids, add, t]);

  const own = useMemo<SubscriptionSetApi>(
    () => ({
      ready: state.ready,
      known: state.known,
      has: (anilistId: number) => state.ids.has(anilistId),
      add,
      remove,
    }),
    [state, add, remove],
  );

  return (
    <SubscriptionSetContext.Provider value={outer ?? own}>
      {children}
    </SubscriptionSetContext.Provider>
  );
}

/**
 * Read the shared set. Safe to call outside a provider — see
 * SUBSCRIPTION_SET_FALLBACK.
 */
export function useSubscriptionSet(): SubscriptionSetApi {
  return useContext(SubscriptionSetContext) ?? SUBSCRIPTION_SET_FALLBACK;
}
