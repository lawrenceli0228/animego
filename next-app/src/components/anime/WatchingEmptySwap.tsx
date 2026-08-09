"use client";

// Swaps ContinueWatching's zero-subscription copy the moment a subscription
// actually happens elsewhere on the page.
//
// The problem it solves is a self-contradicting screen: `/` is force-dynamic,
// the server reads `?status=watching`, gets zero rows, and renders "you're not
// tracking anything yet — tap + on any poster". The visitor does exactly that
// in the trending grid twelve pixels above, the card flips to ✓ … and the
// paragraph underneath still says they are not tracking anything.
//
// Deliberately NOT router.refresh(). That would re-run the whole RSC tree for
// one paragraph of copy — on `/` it means re-fetching trending, the schedule,
// the gems, the activity feed and the rankings, and the same reflex on
// /search or /seasonal would re-run those queries too. The subscriptionBus
// event already carries everything the decision needs.
//
// This component holds no server data of its own: both bodies arrive
// pre-rendered from ContinueWatching (a Server Component) as props, so the
// copy, the dictionary and the layout all stay on the server. All that lives
// on the client is a set of ids — which is also why ContinueWatching stays a
// Server Component instead of becoming "use client" (2026-06-05: islanding a
// server block on `/` is what produced the site-wide phantom-logout).

import { useEffect, useState, type ReactNode } from "react";
import { subscribeToBus } from "@/lib/subscriptionBus";
import { nextWatchingIds } from "./continueWatchingState";

const NOTHING: ReadonlySet<number> = new Set<number>();

interface WatchingEmptySwapProps {
  /** The zero-subscription stub, server-rendered. Shown until something lands. */
  children: ReactNode;
  /** Server-rendered replacement, shown once a `watching` row is created. */
  filled: ReactNode;
}

export default function WatchingEmptySwap({
  children,
  filled,
}: WatchingEmptySwapProps): React.ReactElement {
  // Starts empty on both sides of hydration — the server render is the
  // authority on what the list held when the page was built, and the client
  // only ever learns about writes that happen after it.
  //
  // Ids, not a boolean, because the swap has to be reversible: the quick-add
  // toast carries an Undo, and a latched flag would leave this section saying
  // "added to Watching" after the user took it back — the same contradiction
  // this component exists to remove, pointing the other way.
  const [added, setAdded] = useState<ReadonlySet<number>>(NOTHING);

  useEffect(
    () => subscribeToBus((detail) => setAdded((prev) => nextWatchingIds(prev, detail))),
    [],
  );

  return <>{added.size > 0 ? filled : children}</>;
}
