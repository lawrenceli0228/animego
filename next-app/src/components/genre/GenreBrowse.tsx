"use client";

// The genre page's client root: the view with the real follow buttons, under
// one subscription-set provider — one /api/subscriptions request for every
// card on the page, none at all for a visitor.

import { SubscriptionSetProvider } from "@/components/anime/SubscriptionSetProvider";
import FollowButton from "@/components/seasonal/browse/FollowButton";
import GenreView, { type GenreViewProps } from "./GenreView";

export type GenreBrowseProps = Omit<GenreViewProps, "Follow">;

/**
 * A key per server render of the page, as the seasonal page keys its view.
 * The router keeps this component when a navigation lands on the same genre
 * with another query (the hub → a grid, the grid → the hub, Back / Forward
 * between them), and the view's state — what is loading, the pages fetched
 * after the first — would carry over. Each navigation brings a fresh `data`
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

export default function GenreBrowse(props: GenreBrowseProps) {
  return (
    <SubscriptionSetProvider>
      <GenreView key={renderKey(props.data)} {...props} Follow={FollowButton} />
    </SubscriptionSetProvider>
  );
}
