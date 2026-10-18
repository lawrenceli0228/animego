"use client";

// The behaviour behind a one-tap "追番": what a press means, the write, the
// confirmation toast with its Undo, and the signed-out round trip through
// /login. Lifted out of QuickSubscribeToggle so the homepage hero's button runs
// the exact same flow instead of a second copy of it — the poster corner and
// the hero differ only in what they look like.
//
// THE ONE RULE still holds for a poster corner: nothing there deletes, except
// the Undo inside the success toast, at the one instant the row provably has
// no history to lose. See QuickSubscribeToggle for the full argument.
//
// The seasonal page's ✓ unfollows (`unfollow`), and holds to the same rule by
// other means: it asks the server to delete only a row with nothing but the
// follow (DELETE ?ifUntouched=1), and for a row holding more it hands back
// what the row holds so the page can ask the reader before `unfollowAnyway`.

import Link from "@/components/ui/LocaleLink";
import { useLocaleRouter } from "@/components/ui/LocaleLink";
import { useRef, useState, type CSSProperties } from "react";
import toast, { type Toast } from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import { stashPendingSubscribe } from "@/lib/pendingSubscribe";
import type { SubscriptionDoc } from "@/lib/subscriptionBus";
import { useSubscriptionSet } from "./SubscriptionSetProvider";
import { LIST_HINT_TOAST_MS, hintStore, takeListHint } from "./subscriptionToast";
import { loginTarget, quickSubscribeMode, type QuickSubscribeMode } from "./quickSubscribeState";

const toastRowStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 10,
};

const toastLinkStyle: CSSProperties = {
  color: "#0a84ff",
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

// Undo is an action, not a destination, so it is a <button> that merely looks
// like the link next to it.
const toastActionStyle: CSSProperties = {
  ...toastLinkStyle,
  padding: 0,
  border: "none",
  background: "transparent",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
};

export interface QuickSubscribe {
  /** False until the subscription set has loaded; a press before then is ignored. */
  ready: boolean;
  mode: QuickSubscribeMode;
  busy: boolean;
  /** Write the subscription — or, signed out, stash the intent and go log in. */
  press: () => Promise<void>;
  /**
   * ✓ pressed again (the seasonal page). A row with nothing but the follow is
   * deleted, with an Undo in the toast; for one holding more nothing changes,
   * and the outcome carries what it holds so the caller can ask first.
   */
  unfollow: () => Promise<UnfollowOutcome>;
  /** The reader said yes: the plain DELETE, history and all. */
  unfollowAnyway: () => Promise<void>;
}

/** What a press on the seasonal page's ✓ came to. */
export type UnfollowOutcome =
  | { kind: "done" }
  /** The row holds history and is untouched; `doc` is what it holds (null if the read failed). */
  | { kind: "ask"; doc: SubscriptionDoc | null };

export function useQuickSubscribe(anilistId: number): QuickSubscribe {
  const router = useLocaleRouter();
  const { t } = useLang();
  const subs = useSubscriptionSet();
  const [busy, setBusy] = useState(false);
  // The state drives the paint; the ref drives the guard. `setBusy` only
  // queues a re-render, so two events inside one task (a double-tap, a held
  // Enter) would both read the old `busy` and both POST. The ref is written
  // synchronously, so the second one sees it.
  const busyRef = useRef(false);

  const mode = quickSubscribeMode(subs.known, subs.has(anilistId));

  /**
   * The compensation for a mis-tap. Safe here and nowhere else: the row was
   * created milliseconds ago, so DELETE can only take back what this press
   * just made.
   */
  const undo = async () => {
    if (await subs.remove(anilistId)) toast.success(t("sub.toastRemoved"));
    else toast.error(t("card.quickAddFail"));
  };

  const notifyAdded = (withListHint: boolean) => {
    toast.success(
      (instance: Toast) => (
        <span style={toastRowStyle}>
          {t("sub.toastAdded")}
          <button
            type="button"
            style={toastActionStyle}
            onClick={() => {
              // Dismiss first: the button vanishes with the toast, which is
              // what stops a double-tap becoming two DELETEs.
              toast.dismiss(instance.id);
              void undo();
            }}
          >
            {t("sub.toastUndo")}
          </button>
          {withListHint ? (
            <Link
              href="/profile"
              prefetch={false}
              style={toastLinkStyle}
              onClick={() => toast.dismiss(instance.id)}
            >
              {t("sub.toastViewList")}
            </Link>
          ) : null}
        </span>
      ),
      // Carries up to two actions; the Toaster's 3500ms default is gone before
      // a thumb reaches the top of a phone screen.
      { duration: LIST_HINT_TOAST_MS },
    );
  };

  const refollow = async () => {
    if (await subs.add(anilistId)) toast.success(t("sub.toastAdded"));
    else toast.error(t("card.quickAddFail"));
  };

  // The row held nothing but the follow, so following again puts back
  // everything that went.
  const notifyUnfollowed = () => {
    toast.success(
      (instance: Toast) => (
        <span style={toastRowStyle}>
          {t("sub.toastUnfollowed")}
          <button
            type="button"
            style={toastActionStyle}
            onClick={() => {
              toast.dismiss(instance.id);
              void refollow();
            }}
          >
            {t("sub.toastUndo")}
          </button>
        </span>
      ),
      { duration: LIST_HINT_TOAST_MS },
    );
  };

  const unfollow = async (): Promise<UnfollowOutcome> => {
    if (!subs.ready || busyRef.current || mode !== "open") return { kind: "done" };
    busyRef.current = true;
    setBusy(true);
    try {
      const verdict = await subs.removeIfUntouched(anilistId);
      if (verdict === "removed") {
        notifyUnfollowed();
        return { kind: "done" };
      }
      if (verdict === "kept") return { kind: "ask", doc: await subs.read(anilistId) };
      toast.error(t("card.quickAddFail"));
      return { kind: "done" };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const unfollowAnyway = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (await subs.remove(anilistId)) toast.success(t("sub.toastUnfollowed"));
      else toast.error(t("card.quickAddFail"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const press = async () => {
    if (!subs.ready || busyRef.current) return;

    // Signed out: keep the intent, send them to log in, and let the provider
    // finish the job when they land back here. Reading location directly (not
    // useSearchParams) keeps callers out of the Suspense constraints that hook
    // drags onto every page hosting one.
    if (mode === "signedOut") {
      stashPendingSubscribe(anilistId);
      router.push(loginTarget(window.location.pathname, window.location.search));
      return;
    }
    if (mode !== "add") return;

    busyRef.current = true;
    setBusy(true);
    try {
      if (!(await subs.add(anilistId))) {
        toast.error(t("card.quickAddFail"));
        return;
      }
      // The first successful add on this browser carries a signpost to the
      // list it just filled; later adds stay a plain confirmation. Shared with
      // SubscriptionButton so only one surface spends the one-time hint.
      notifyAdded(takeListHint(hintStore()));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return { ready: subs.ready, mode, busy, press, unfollow, unfollowAnyway };
}
