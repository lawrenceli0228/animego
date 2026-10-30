"use client";

// Cover grid, chart cards or list. A phone offers the grid and the list (the
// table view, drawn as a phone's rows); its chart button is hidden.

import type { ReactNode } from "react";
import { ChartIcon, GridIcon, ListIcon } from "@/components/seasonal/browse/icons";
import type { ViewKey } from "@/lib/seasonal/state";
import type { TopCopy } from "./useTopCopy";
import top from "./top.module.css";

interface ViewToggleProps {
  view: ViewKey;
  onView: (view: ViewKey) => void;
  copy: TopCopy;
}

export default function ViewToggle({ view, onView, copy }: ViewToggleProps) {
  const button = (key: ViewKey, label: string, icon: ReactNode) => (
    <button
      type="button"
      className={top.view}
      aria-pressed={view === key}
      aria-label={label}
      title={label}
      data-view-toggle={key}
      onClick={() => onView(key)}
    >
      {icon}
    </button>
  );
  return (
    <div className={top.views} role="group" aria-label={copy.views}>
      {button("grid", copy.viewGrid, <GridIcon />)}
      {button("chart", copy.viewChart, <ChartIcon />)}
      {button("table", copy.viewTable, <ListIcon />)}
    </div>
  );
}
