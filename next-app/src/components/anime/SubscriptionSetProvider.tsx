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

import Link from "@/components/ui/LocaleLink";
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

import {
  ANONYMOUS_STATE,
  LOADING,
  QUICK_ADD_STATUS,
  SUBSCRIPTION_SET_FALLBACK,
  applySubscriptionChange,
  classifyCreateStatus,
  classifyDeleteStatus,
  docFromResponse,
  nextSubscriptionSet,
  subscribedIdsFromList,
  withIds,
  type SubscriptionSetApi,
  type SubscriptionSetState,
} from "./subscriptionSetState";

// Re-exported so existing importers (Navbar, SignedOutGate, the cards) keep
// one import path, and so this file stays the public face of the feature.
export {
  ANONYMOUS_STATE,
  SIGNED_OUT_EVENT,
  SUBSCRIPTION_SET_FALLBACK,
  applySubscriptionChange,
  broadcastSignedOut,
  classifyCreateStatus,
  classifyDeleteStatus,
  nextSubscriptionSet,
  subscribeToSignedOut,
  subscribedIdsFromList,
  type SubscriptionSetApi,
  type SubscriptionSetState,
  type WriteIntent,
  type WriteOutcome,
  type WriteVerdict,
} from "./subscriptionSetState";

import { SIGNED_OUT_EVENT, broadcastSignedOut, subscribeToSignedOut } from "./subscriptionSetState";

const SubscriptionSetContext = createContext<SubscriptionSetApi | null>(null);

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
