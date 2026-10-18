"use client";

// The seasonal page's client root: the browse view with the real follow
// buttons, under one subscription-set provider — one /api/subscriptions
// request for every card on the page, none at all for a visitor.

import { SubscriptionSetProvider } from "@/components/anime/SubscriptionSetProvider";
import BrowseView, { type BrowseViewProps } from "./BrowseView";
import FollowButton from "./FollowButton";

export type SeasonalBrowseProps = Omit<BrowseViewProps, "Follow">;

/**
 * A key per server render of the page. The router keeps this component when
 * a navigation lands on the same season with another query (the navbar's
 * 季度 link from a filtered page, Back / Forward between two entries of the
 * same address), and BrowseView's state would carry on as if nothing had
 * happened. Each such navigation brings a fresh `initial` from the server,
 * while the page's own history.replaceState calls never do, so keying on that
 * object remounts the view for navigations only.
 */
const renders = new WeakMap<object, number>();
let lastRender = 0;
function renderKey(initial: object): number {
  let key = renders.get(initial);
  if (key === undefined) {
    lastRender += 1;
    key = lastRender;
    renders.set(initial, key);
  }
  return key;
}

export default function SeasonalBrowse(props: SeasonalBrowseProps) {
  return (
    <SubscriptionSetProvider>
      <BrowseView key={renderKey(props.initial)} {...props} Follow={FollowButton} />
    </SubscriptionSetProvider>
  );
}
