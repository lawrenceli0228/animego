"use client";

// The release-group switch: "All" and every group, most releases first, in
// fixed cells that scroll sideways, with the genre page's sliding indicator
// under the current one.

import { useEffect, useRef } from "react";
import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import type { FansubCell } from "@/lib/magnet/list";
import s from "./MagnetPanel.module.css";

interface FansubStripProps {
  cells: readonly FansubCell[];
  selected: string | null;
  /** Shown while the list is loading, when there are no counts yet. */
  pending: boolean;
  onPick: (key: string | null) => void;
}

/** The gap between cells, px — the indicator's step is one cell plus this. */
const GAP_PX = 4;

export default function FansubStrip({ cells, selected, pending, onPick }: FansubStripProps) {
  const { t } = useLang();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const index = Math.max(
    0,
    cells.findIndex((cell) => cell.key === selected),
  );

  // Keep the current cell in view: "clear filters" sends the indicator back
  // to "All", which may be scrolled out of sight.
  useEffect(() => {
    const current = scrollerRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [index]);

  return (
    <div ref={scrollerRef} className={`${s.hscroll} ${s.stripScroll}`}>
      <nav className={s.strip} aria-label={t("torrent.fansubsAria")}>
        <i
          className={s.ind}
          style={{ transform: `translateX(calc(${index} * (100% + ${GAP_PX}px)))` }}
          aria-hidden="true"
        />
        {cells.map((cell) => {
          const name = cell.key === null ? t("torrent.groupAll") : cell.key || t("torrent.unnamed");
          const count = pending ? "–" : String(cell.count);
          return (
            <button
              key={cell.key === null ? "all" : `g:${cell.key}`}
              type="button"
              className={s.cell}
              aria-pressed={cell.key === selected}
              aria-label={pending ? name : fillTemplate(t("torrent.fansubCount"), { name, n: cell.count })}
              title={name}
              onClick={() => onPick(cell.key)}
            >
              <b>{name}</b>
              <span aria-hidden="true">{count}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
