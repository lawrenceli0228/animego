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

import Link from "@/components/ui/LocaleLink";
import { useState, type CSSProperties } from "react";
import { useLang } from "@/lib/lang-client";
import { useQuickSubscribe } from "./useQuickSubscribe";

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
    fontFamily: "var(--font-display)",
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

import {
  detailTarget,
  loginTarget,
  quickSubscribeMode,
  type QuickSubscribeMode,
} from "./quickSubscribeState";

// Re-exported so this file stays the feature's public face.
export {
  detailTarget,
  loginTarget,
  quickSubscribeMode,
  type QuickSubscribeMode,
} from "./quickSubscribeState";

export default function QuickSubscribeToggle({
  anilistId,
  title,
}: QuickSubscribeToggleProps): React.ReactElement | null {
  const { t } = useLang();
  // What a press means and what it does — the write, the toast with its Undo,
  // the signed-out round trip — lives in useQuickSubscribe, shared with the
  // homepage hero. This component is only the poster-corner look of it.
  const { ready, mode, busy, press } = useQuickSubscribe(anilistId);
  const [hovered, setHovered] = useState(false);

  // Until the provider settles we render nothing rather than guess. The
  // button is absolutely positioned, so appearing later costs no layout
  // shift — whereas guessing "not subscribed" would flash a + at users who
  // already track the show.
  if (!ready) return null;

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
      onClick={() => void press()}
      {...hoverProps}
    >
      <span style={pillStyle(false, hovered, busy)} aria-hidden>
        +
      </span>
    </button>
  );
}
