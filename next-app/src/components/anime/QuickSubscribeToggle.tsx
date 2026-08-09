"use client";

// The + / ✓ that turns a poster into a one-tap subscribe.
//
// Why this exists: 91.8% of subscribers on prod have exactly one anime in
// their list. Nothing about that is a taste problem — the ONLY place the site
// ever rendered a subscribe control was the detail page, so adding a second
// show cost five interactions (back → find → open → scroll → click). This
// button collapses that to one, on the surface where people are already
// browsing.
//
// THE ONE RULE: this corner never deletes. "+" writes a subscription; "✓" is
// a link to the detail page and nothing else. It is not a toggle.
//
// The rule exists because the set behind it is unfiltered — GET
// /api/subscriptions returns completed and dropped rows too, so a show
// finished in 2025 with a 10/10 score renders ✓ in an unrelated /search grid
// in 2026. If ✓ meant DELETE, one mis-swipe on a 44px corner would drop the
// whole row: score, current_episode, history. POST is non-destructive
// (ON CONFLICT DO UPDATE SET status only); DELETE removes the row. So the
// grid gets the safe verb and the detail page — which has the status picker,
// the episode counter, the score and an explicit Remove — gets the other one.
//
// The compensation for a mis-tapped "+" is the Undo action inside the success
// toast: at that instant the row was *just* created, so there is provably no
// accumulated state to lose. That is the only moment a delete from here is
// safe, and it is the only place we offer it.
//
// It reads state from SubscriptionSetProvider (one list load for the whole
// grid) and writes through it, so the optimistic paint, the rollback, and the
// subscriptionBus broadcast all live in one place. Without a provider it
// still renders and still routes signed-out visitors to /login — see
// useSubscriptionSet's NO_PROVIDER fallback.
//
// Layout contract with AnimeCard: absolutely positioned bottom-right, ABOVE
// the stretched link overlay. Because it sits higher in the stacking order it
// takes its own clicks natively — no preventDefault/stopPropagation games,
// and no <button> nested inside an <a>.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type CSSProperties } from "react";
import toast, { type Toast } from "react-hot-toast";
import { useLang } from "@/lib/lang-client";
import { stashPendingSubscribe } from "@/lib/pendingSubscribe";
import { useSubscriptionSet } from "./SubscriptionSetProvider";
import { LIST_HINT_TOAST_MS, hintStore, takeListHint } from "./subscriptionToast";

interface QuickSubscribeToggleProps {
  anilistId: number;
  /** Already language-resolved by the card — used verbatim in the aria-label. */
  title: string;
}

// The visible pill is 34px, which is all the room a poster corner can spare
// without covering the artwork. The <button> around it is 44px — Apple's and
// Google's floor for a touch target, and the reason the hit area and the
// visual are two separate boxes here. Site-wide this is currently the second
// control to clear 44px; new code does not get to repeat that miss.
const HIT_SIZE = 44;
const PILL_SIZE = 34;
// (44 - 34) / 2 = 5px of transparent padding, so offsetting the hit box by 3
// leaves the visible pill 8px from the card edge — matching the score and
// watcher badges in the other three corners.
const EDGE_INSET = 3;

const hitStyle: CSSProperties = {
  position: "absolute",
  right: EDGE_INSET,
  bottom: EDGE_INSET,
  width: HIT_SIZE,
  height: HIT_SIZE,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "none",
  background: "transparent",
  // Set for the <a> branch; harmless on the <button> one.
  textDecoration: "none",
  cursor: "pointer",
  // Above the stretched link (z-index 1) so the corner belongs to us.
  zIndex: 2,
  WebkitTapHighlightColor: "transparent",
  // Pull the focus ring inside the box; the card clips overflow, and a ring
  // drawn outside a corner-anchored button would be half invisible.
  outlineOffset: -2,
};

function pillStyle(
  subscribed: boolean,
  hovered: boolean,
  busy: boolean,
): CSSProperties {
  return {
    width: PILL_SIZE,
    height: PILL_SIZE,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'Sora', sans-serif",
    // ✓ needs less optical size than + to read at the same weight.
    fontSize: subscribed ? 16 : 22,
    fontWeight: 400,
    lineHeight: 1,
    // Solid-ish dark disc, no border. The earlier version carried a 1px white
    // outline to survive a bright poster; the reveal transition made that ring
    // the most eye-catching thing in the grid on every pointer move. A denser
    // fill does the same legibility job silently.
    //
    // No backdrop-filter — measured p95 frame time 41.6ms with blurred badges
    // against 19.9ms without, on a surface that also animates on hover.
    background: subscribed
      ? "rgba(10,132,255,0.95)"
      : hovered
        ? "rgba(0,0,0,0.82)"
        : "rgba(0,0,0,0.68)",
    color: "#ffffff",
    boxShadow: "0 2px 10px rgba(0,0,0,0.45)",
    opacity: busy ? 0.5 : 1,
    // Scale, not width/height: the 44px hit box is unaffected either way, so
    // the touch target stays legal at every size while only the painted disc
    // moves — and scale is composited, so a grid of 20 cards animating at once
    // never touches layout.
    //
    // The two states want opposite defaults. "+" is an affordance: it is
    // hidden at rest (globals.css .agc-quick-add) and full size the moment it
    // appears, because it is asking to be clicked. "✓" is information: it must
    // stay visible so the grid reads at a glance, but at full size twenty of
    // them turn a poster wall into a field of blue dots. So it sits small and
    // quiet, then opens to full size under the pointer, where it stops being a
    // status light and becomes "click me to open this series".
    transform: busy
      ? "none"
      : subscribed
        ? hovered
          ? "scale(1.06)"
          : "scale(0.72)"
        : hovered
          ? "scale(1.10)"
          : "none",
    transition: "background 160ms, opacity 160ms, transform 200ms cubic-bezier(0.16,1,0.3,1)",
  };
}

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

/** What the button means right now. */
export type QuickSubscribeMode = "signedOut" | "add" | "open";

/**
 * Collapse the two provider flags into the single decision the button renders
 * and acts on.
 *
 * `known === false` wins outright: that covers anonymous visitors, a page that
 * forgot the provider, and a session that 401'd mid-visit. In all three the
 * only honest affordance is "log in first" — showing ✓ off a stale set would
 * promise a write we cannot make.
 *
 * The subscribed mode is called `open`, not `remove`, on purpose: the name is
 * the contract. Whatever status the row carries — watching, completed,
 * dropped — the answer from this corner is always "go to the detail page",
 * so there is no branch here that could ever grow a DELETE.
 */
export function quickSubscribeMode(
  known: boolean,
  subscribed: boolean,
): QuickSubscribeMode {
  if (!known) return "signedOut";
  return subscribed ? "open" : "add";
}

/**
 * Build the /login round-trip URL that brings the visitor back to this exact
 * grid — same page, same filters, same search query — so the poster they
 * pressed is still on screen when the pending write lands.
 */
export function loginTarget(pathname: string, search: string): string {
  const from = `${pathname}${search}` || "/";
  return `/login?from=${encodeURIComponent(from)}`;
}

/** Where ✓ sends the viewer: the surface that owns every other subscription verb. */
export function detailTarget(anilistId: number): string {
  return `/anime/${anilistId}`;
}

export default function QuickSubscribeToggle({
  anilistId,
  title,
}: QuickSubscribeToggleProps): React.ReactElement | null {
  const router = useRouter();
  const { t } = useLang();
  const subs = useSubscriptionSet();
  const [busy, setBusy] = useState(false);
  // The state drives the paint (opacity + aria-disabled); the ref drives the
  // guard. `setBusy` only queues a re-render, so two events delivered inside
  // one task — a double-tap, or a held Enter repeating — both read the old
  // `busy` from their own render closure and both fire a POST. The ref is
  // written synchronously, so the second one sees it.
  const busyRef = useRef(false);
  const [hovered, setHovered] = useState(false);

  // Until the provider settles we render nothing rather than guess. The
  // button is absolutely positioned, so appearing later costs no layout
  // shift — whereas guessing "not subscribed" would flash a + at users who
  // already track the show.
  if (!subs.ready) return null;

  const mode = quickSubscribeMode(subs.known, subs.has(anilistId));

  // Hover is the one thing both branches share.
  const hoverProps = {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onFocus: () => setHovered(true),
    onBlur: () => setHovered(false),
  };

  // Already tracking it → a link, not a toggle. Rendering an <a> rather than
  // a <button aria-pressed> is the accessible truth of what happens: pressing
  // this navigates. aria-pressed would announce "toggle button, pressed",
  // which promises that pressing again un-presses it — exactly the delete
  // this control refuses to do. The label carries both facts (you track this;
  // this opens the detail page) so a screen-reader user is never surprised by
  // the navigation. Three literal t() calls, never a computed key: the
  // spa-dictionary CI gate only sees string literals.
  if (mode === "open") {
    return (
      <Link
        href={detailTarget(anilistId)}
        prefetch={false}
        className="agc-quick-add is-subscribed"
        style={hitStyle}
        aria-label={`${t("card.quickAdded")} · ${t("detail.viewDetails")}: ${title}`}
        {...hoverProps}
      >
        <span style={pillStyle(true, hovered, false)} aria-hidden>
          ✓
        </span>
      </Link>
    );
  }

  const label = mode === "signedOut" ? t("card.quickAddLogin") : t("card.quickAdd");

  /**
   * The compensation for a mis-tap. Safe here and nowhere else: the row was
   * created milliseconds ago, so DELETE can only take back what this click
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
      // The Toaster's 3500ms default is for "done" toasts nobody has to act
      // on. This one carries up to two actions; 3500ms on a phone is gone
      // before a thumb travelling from the bottom of a grid reaches the top
      // of the screen.
      { duration: LIST_HINT_TOAST_MS },
    );
  };

  const handleClick = async () => {
    if (busyRef.current) return;

    // Signed out: keep the intent, send them to log in, and let the provider
    // finish the job when they land back here. Reading location directly (not
    // useSearchParams) keeps this component out of the Suspense/static-render
    // constraints that hook drags onto every page hosting a card grid.
    if (mode === "signedOut") {
      stashPendingSubscribe(anilistId);
      router.push(
        loginTarget(window.location.pathname, window.location.search),
      );
      return;
    }

    busyRef.current = true;
    setBusy(true);
    try {
      if (!(await subs.add(anilistId))) {
        toast.error(t("card.quickAddFail"));
        return;
      }
      // The first successful add on this browser carries a signpost to the
      // list it just filled — nobody discovers /profile on their own. Later
      // adds stay a plain confirmation, or a grid session of five would show
      // the same link five times. takeListHint is shared with
      // SubscriptionButton so the detail page and the grid can't both spend
      // the one-time hint.
      notifyAdded(takeListHint(hintStore()));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`agc-quick-add${busy ? " is-busy" : ""}`}
      style={hitStyle}
      // aria-disabled, NOT disabled. `disabled` removes the element from the
      // tab order mid-write: a keyboard user on the 12th card of /seasonal
      // presses Enter, focus drops to <body>, and getting back means ~25 Tab
      // presses from the top of the document. The click guard above already
      // prevents the double submit that `disabled` was there for.
      aria-disabled={busy}
      aria-label={`${label}: ${title}`}
      onClick={handleClick}
      {...hoverProps}
    >
      <span style={pillStyle(false, hovered, busy)} aria-hidden>
        +
      </span>
    </button>
  );
}
