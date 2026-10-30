"use client";

// The ranking pages' client root: the view with the real follow buttons, under
// one subscription-set provider — one /api/subscriptions request for every
// card on the page, none at all for a visitor.

import { SubscriptionSetProvider } from "@/components/anime/SubscriptionSetProvider";
import FollowButton from "@/components/seasonal/browse/FollowButton";
import TopView, { type TopViewProps } from "./TopView";

export type TopBrowseProps = Omit<TopViewProps, "Follow">;

/**
 * A key per server render of the page, as the genre page keys its view. The
 * router keeps this component when a navigation lands on the same route with
 * another query (a format, a genre), and the view's state — what is pending,
 * the batches open — would carry over. Each navigation brings a fresh `data`
 * from the server, while the page's own history.replaceState calls never do,
 * so keying on that object remounts the view for navigations only.
 */
const renders = new WeakMap<object, number>();
let lastRender = 0;
function renderKey(data: object): number {
  let key = renders.get(data);
  if (key === undefined) {
    lastRender += 1;
    key = lastRender;
    renders.set(data, key);
  }
  return key;
}

export default function TopBrowse(props: TopBrowseProps) {
  return (
    <SubscriptionSetProvider>
      <TopView key={renderKey(props.data)} {...props} Follow={FollowButton} />
    </SubscriptionSetProvider>
  );
}
