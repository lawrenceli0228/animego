"use client";

// The seasonal page's client root: the browse view with the real follow
// buttons, under one subscription-set provider — one /api/subscriptions
// request for every card on the page, none at all for a visitor.

import { SubscriptionSetProvider } from "@/components/anime/SubscriptionSetProvider";
import BrowseView, { type BrowseViewProps } from "./BrowseView";
import FollowButton from "./FollowButton";

export type SeasonalBrowseProps = Omit<BrowseViewProps, "Follow">;

export default function SeasonalBrowse(props: SeasonalBrowseProps) {
  return (
    <SubscriptionSetProvider>
      <BrowseView {...props} Follow={FollowButton} />
    </SubscriptionSetProvider>
  );
}
