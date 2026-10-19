"use client";

// What the content area shows while the next view of the page is on its way
// — another genre's hub, a grid, the hub again: the seasonal page's shimmer
// (2s), in the shape of what is coming.

import cards from "@/components/seasonal/browse/cards.module.css";
import states from "@/components/seasonal/browse/states.module.css";
import { range, SkeletonCard } from "./parts";
import grid from "./grid.module.css";
import hub from "./hub.module.css";

/** Three rows of rail covers beside six ranking rows. */
export function HubSkeleton() {
  return (
    <div className={`${hub.body} ${hub.skBody}`} aria-hidden="true" data-skeleton="hub">
      <div className={`${hub.skRows} ${states.fade}`}>
        {range(18).map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
      <div className={`${hub.side} ${states.fade}`}>
        {range(6).map((i) => (
          <div key={i} className={`${hub.skRank} ${states.sk}`} />
        ))}
      </div>
    </div>
  );
}

/** Three rows of the grid. */
export function GridSkeleton() {
  return (
    <div className={cards.results} aria-busy="true">
      <div className={`${cards.grid} ${states.fade} ${grid.skGrid}`} aria-hidden="true" data-skeleton="grid">
        {range(18).map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

/** One row of covers where "show more" was, while the next page loads. */
export function MoreSkeleton() {
  return (
    <div className={`${cards.grid} ${grid.skMore}`} aria-hidden="true" data-skeleton="more">
      {range(6).map((i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
