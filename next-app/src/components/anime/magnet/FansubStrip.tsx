"use client";

// The release-group switch: "All" and every group, most releases first, in
// fixed cells on a sideways rail, with the genre page's sliding indicator
// under the current one.
//
// The rail is the homepage's (components/home/useRail.ts, as 今日更新 and
// 按色调逛 use it): touch scrolls it natively; a mouse drags it — letting go
// over a cell does not pick that cell, and a quick drag flings on and comes to
// rest with a cell first — and under it is 今日更新's slider, in the anime's
// tone: its thumb dragged, its track clicked, or the range input behind it used
// from the keyboard. The slider is drawn only when the groups do not all fit.
//
// The hooks rest the rail on its children, so the cells are its only
// children; the pill behind them and the indicator are drawn by the rail's
// ::before and ::after (FansubStrip.module.css).

import { useEffect, useId, useRef, type CSSProperties } from "react";
import { useRailDrag, useRailMotion, useRailSlider } from "@/components/home/useRail";
import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import type { FansubCell } from "@/lib/magnet/list";
import s from "./FansubStrip.module.css";

interface FansubStripProps {
  cells: readonly FansubCell[];
  selected: string | null;
  /** Shown while the list is loading, when there are no counts yet. */
  pending: boolean;
  onPick: (key: string | null) => void;
}

type Vars = CSSProperties & Record<`--${string}`, string>;

export default function FansubStrip({ cells, selected, pending, onPick }: FansubStripProps) {
  const { t } = useLang();
  const railId = useId();
  const railRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const motion = useRailMotion(railRef);
  const drag = useRailDrag({ onPress: motion.stop, onRelease: motion.fling });
  const slider = useRailSlider(railRef, { thumbRef, inputRef }, motion, (first, last, total) =>
    fillTemplate(t("torrent.fansubScrollValue"), { from: first, to: last, n: total }),
  );
  const index = Math.max(
    0,
    cells.findIndex((cell) => cell.key === selected),
  );

  // The slider measures the rail whenever it scrolls or changes size. Groups
  // coming and going — the list landing, a subtitle filter — do neither: the
  // rail keeps its size and only what is in it grows or shrinks. So it is
  // asked to measure again.
  useEffect(() => {
    railRef.current?.dispatchEvent(new Event("scroll"));
  }, [cells.length]);

  // Keep the current cell in view: "clear filters" sends the indicator back
  // to "All", which may be scrolled out of sight.
  useEffect(() => {
    const current = railRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [index]);

  // Moved by hand or flung: the cells passing under the pointer do not light up.
  const moving = drag.dragging || slider.dragging || motion.flinging;
  const vars: Vars = { "--cells": String(cells.length), "--at": String(index) };

  return (
    <div className={s.frame}>
      <div
        ref={railRef}
        id={railId}
        className={s.rail}
        style={vars}
        role="group"
        aria-label={t("torrent.fansubsAria")}
        data-dragging={drag.dragging ? "true" : undefined}
        data-moving={moving ? "true" : undefined}
        {...drag.handlers}
      >
        {cells.map((cell) => {
          const name = cell.key === null ? t("torrent.groupAll") : cell.key || t("torrent.unnamed");
          const count = pending ? "–" : String(cell.count);
          return (
            <button
              key={cell.key === null ? "all" : `g:${cell.key}`}
              type="button"
              className={s.cell}
              // The groups are what the slider's spoken value counts; "All" is not one.
              data-card={cell.key === null ? undefined : ""}
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
      </div>
      {/* The keyboard's and assistive technology's way along the strip; the
          slider after it is its picture and the pointer's. Value, max and
          spoken value are kept in step with the rail by useRailSlider. Gone,
          with the slider, while every group fits. */}
      <input
        ref={inputRef}
        type="range"
        className={s.scrub}
        aria-label={t("torrent.fansubScroll")}
        aria-controls={railId}
        min={0}
        step={1}
        defaultValue={0}
        disabled={!slider.overflow}
        hidden={!slider.overflow}
        {...slider.inputHandlers}
      />
      <div
        className={s.slider}
        data-overflow={slider.overflow ? "true" : "false"}
        data-active={slider.active ? "true" : undefined}
        data-dragging={slider.dragging ? "true" : undefined}
        aria-hidden
        {...slider.sliderHandlers}
      >
        <span className={s.track} />
        <span ref={thumbRef} className={s.thumb} />
      </div>
    </div>
  );
}
