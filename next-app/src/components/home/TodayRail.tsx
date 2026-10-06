"use client";

// 今日更新 — today's episodes as one sideways rail, split by a "now" marker:
// aired on the left with a 已播 badge, upcoming on the right, the ones due in
// the next hour counting down with a ping.
//
// A client component for the clock and for moving along the row. Membership
// (which episodes are "today") is decided on the server from the schedule's
// own day group; what changes as the page stays open is only which side of
// "now" each one is on, and that comes from useHomeClock — the server's render
// time through hydration, the browser's minute after. So the first paint is
// already right and hydration cannot mismatch.
//
// Every show of the day is its own card, at every width. Phones used to fold
// the aired half behind one tile, and a card that aired while the page was
// open dropped into the fold: the show disappeared from the row.
//
// Moving along: touch scrolls the row natively (snapping card by card on a
// phone). A desktop mouse wheel cannot — it scrolls the page — so there the
// row is dragged by hand (a drag never opens the card it started on) and
// paged by ← → buttons at its ends. The arithmetic is lib/home/railScroll.ts.

import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { Fragment, useEffect, useRef, type CSSProperties } from "react";
import { nowScrollLeft, pageScrollLeft } from "@/lib/home/railScroll";
import { fillTemplate, hhmm } from "@/lib/home/time";
import { isNextDay, slotToday, type Slot } from "@/lib/home/todaySlots";
import { cardToneVars } from "@/lib/home/tone";
import type { TodayCard } from "@/lib/home/viewModels";
import { useLang } from "@/lib/lang-client";
import SectionHeader from "./SectionHeader";
import { CheckIcon, ChevronIcon } from "./icons";
import { useHomeClock } from "./useHomeClock";
import { railGeometry, useRailDrag, useRailEdges } from "./useTodayRail";
import cards from "./cards.module.css";
import section from "./section.module.css";
import styles from "./TodayRail.module.css";

const RAIL_ID = "home-today-rail";

interface TodayRailProps {
  items: TodayCard[];
  /** The schedule's day key (`YYYY-MM-DD`) — the day these items belong to. */
  dayKey: string;
  /** That day, already formatted on the server ("周四 9月24日"). */
  dayLabel: string;
  serverNowMs: number;
}

/** The rail's inline padding: the page gutter, where a card lines up. */
function gutterOf(rail: HTMLElement): number {
  return parseFloat(getComputedStyle(rail).paddingLeft) || 0;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function TodayRail({ items, dayKey, dayLabel, serverNowMs }: TodayRailProps) {
  const { t } = useLang();
  const { nowMs, timeZone } = useHomeClock(serverNowMs);
  const railRef = useRef<HTMLDivElement | null>(null);
  const edges = useRailEdges(railRef);
  const drag = useRailDrag();

  const { slots, nowIndex } = slotToday(items, nowMs);
  const now = hhmm(nowMs, timeZone);

  // Open the rail at "now": a reader at 23:00 should not have to scroll past
  // fifteen finished episodes to find the next one. Scrolls the rail itself —
  // never scrollIntoView, which would move the page too (the old carousel's
  // rail did exactly that). Instant: this is where the row starts, not a move.
  useEffect(() => {
    const rail = railRef.current;
    const marker = rail?.querySelector<HTMLElement>("[data-now]");
    if (!rail || !marker) return;
    const prev = marker.previousElementSibling as HTMLElement | null;
    const next = marker.nextElementSibling as HTMLElement | null;
    const left = nowScrollLeft(
      railGeometry(rail),
      {
        markerStart: marker.offsetLeft,
        prevStart: prev ? prev.offsetLeft : null,
        nextEnd: next ? next.offsetLeft + next.offsetWidth : marker.offsetLeft + marker.offsetWidth,
      },
      gutterOf(rail),
    );
    if (left !== null) rail.scrollLeft = left;
    // Only on arrival; after that the reader owns the scroll position.
  }, []);

  /** About one view of cards back or forward, landing on a card. */
  const page = (direction: 1 | -1) => {
    const rail = railRef.current;
    if (!rail) return;
    const starts = Array.from(rail.children, (el) => (el as HTMLElement).offsetLeft);
    const left = pageScrollLeft(railGeometry(rail), starts, gutterOf(rail), direction);
    rail.scrollTo({ left, behavior: prefersReducedMotion() ? "instant" : "smooth" });
  };

  const card = (slot: Slot<TodayCard>) => {
    const it = slot.item;
    const tone = cardToneVars(it.hue) as unknown as CSSProperties;
    return (
      <Link
        key={it.key}
        href={it.href}
        prefetch={false}
        className={`${cards.card} ${styles.card}`}
        style={tone}
        data-state={slot.state}
      >
        <div className={`${cards.cover} ${styles.cover}`}>
          <span className={cards.zoom}>
            <FadeImage src={it.cover} alt="" width={148} height={197} className={cards.img} />
          </span>
          <span className={styles.fade} aria-hidden />
          {slot.state === "aired" ? (
            <span className={styles.badge}>
              <CheckIcon size={12} />
              {t("home.todayAired")}
            </span>
          ) : slot.state === "soon" ? (
            <span className={`${styles.badge} ${styles.soon}`}>
              <span className={styles.ping} aria-hidden />
              {fillTemplate(t("home.todayInMinutes"), { n: slot.minutesUntil ?? 1 })}
            </span>
          ) : null}
          <span className={styles.when}>
            {isNextDay(it.at, dayKey, timeZone) ? `${t("home.todayNextDay")} ` : ""}
            <time dateTime={new Date(it.at).toISOString()}>{hhmm(it.at, timeZone)}</time>
            {` · ${fillTemplate(t("home.todayEp"), { ep: it.ep })}`}
          </span>
          <span className={cards.rule} aria-hidden />
        </div>
        <span className={`${cards.title} ${cards.clamp2} ${styles.title}`}>{it.title}</span>
      </Link>
    );
  };

  const marker = (
    <div key="now" className={styles.now} data-now aria-hidden>
      <span className={styles.nowLabel}>{t("home.todayNow")}</span>
      <span className={styles.nowTime}>{now}</span>
      <span className={styles.nowDot} />
      <span className={styles.nowLine} />
    </div>
  );

  return (
    <section className={section.bleed} aria-labelledby="home-today">
      <SectionHeader
        id="home-today"
        title={t("home.todayTitle")}
        count={items.length}
        note={[dayLabel, fillTemplate(t("home.todayNowAt"), { time: now })].filter(Boolean).join(" · ")}
        link={{ href: "/calendar", label: t("home.fullSchedule") }}
        phoneHides={["note"]}
      />
      {items.length === 0 ? (
        <p className={`${section.empty} ${styles.empty}`}>{t("home.noUpdates")}</p>
      ) : (
        <div className={styles.frame} data-overflow={edges.overflow ? "true" : "false"}>
          {/* aria-disabled, not disabled: a focused button that became
              disabled at the end of the row would drop keyboard focus. */}
          <button
            type="button"
            className={`${styles.arrow} ${styles.prev}`}
            aria-label={t("home.todayPrevPage")}
            aria-controls={RAIL_ID}
            aria-disabled={edges.atStart}
            onClick={() => {
              if (!edges.atStart) page(-1);
            }}
          >
            <ChevronIcon size={18} className={styles.back} />
          </button>
          <div
            ref={railRef}
            id={RAIL_ID}
            className={styles.rail}
            data-dragging={drag.dragging ? "true" : undefined}
            {...drag.handlers}
          >
            {slots.map((slot, i) => (
              <Fragment key={slot.item.key}>
                {i === nowIndex ? marker : null}
                {card(slot)}
              </Fragment>
            ))}
            {nowIndex === slots.length ? marker : null}
          </div>
          <button
            type="button"
            className={`${styles.arrow} ${styles.next}`}
            aria-label={t("home.todayNextPage")}
            aria-controls={RAIL_ID}
            aria-disabled={edges.atEnd}
            onClick={() => {
              if (!edges.atEnd) page(1);
            }}
          >
            <ChevronIcon size={18} />
          </button>
        </div>
      )}
    </section>
  );
}
