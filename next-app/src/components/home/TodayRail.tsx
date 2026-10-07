"use client";

// 今日更新 — today's episodes as one sideways rail, split by a "now" marker:
// aired on the left with a 已播 badge, upcoming on the right, the ones due in
// the next hour counting down with a ping. The row ends by saying the day is
// over, what tomorrow holds and where the full schedule is.
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
// row is dragged by hand (a drag never opens the card it started on; a quick
// one flings on and comes to rest on a card). Under the row, at every width,
// a thin slider: its thumb is as wide as the share of the row in view, and is
// dragged, or the track clicked, or the keyboard used on the range input
// behind it. The arithmetic is lib/home/railScroll.ts; the wiring is
// useTodayRail.ts.

import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { Fragment, useEffect, useRef, type CSSProperties } from "react";
import { nowScrollLeft } from "@/lib/home/railScroll";
import { fillTemplate, hhmm } from "@/lib/home/time";
import { isNextDay, slotToday, type Slot } from "@/lib/home/todaySlots";
import { cardToneVars } from "@/lib/home/tone";
import type { TodayCard } from "@/lib/home/viewModels";
import { useLang } from "@/lib/lang-client";
import SectionHeader from "./SectionHeader";
import { CheckIcon, ChevronIcon } from "./icons";
import { useHomeClock } from "./useHomeClock";
import {
  gutterOf,
  railGeometry,
  useRailDrag,
  useRailEntrance,
  useRailMotion,
  useRailSlider,
} from "./useTodayRail";
import cards from "./cards.module.css";
import section from "./section.module.css";
import styles from "./TodayRail.module.css";

const RAIL_ID = "home-today-rail";

/** The day after today, for the end of the row: already formatted on the server. */
export interface TodayRailTomorrow {
  /** "周日 10月11日". */
  label: string;
  /** Episodes on it; 0 says only which day it is. */
  count: number;
}

interface TodayRailProps {
  items: TodayCard[];
  /** The schedule's day key (`YYYY-MM-DD`) — the day these items belong to. */
  dayKey: string;
  /** That day, already formatted on the server ("周四 9月24日"). */
  dayLabel: string;
  tomorrow: TodayRailTomorrow | null;
  serverNowMs: number;
}

export default function TodayRail({ items, dayKey, dayLabel, tomorrow, serverNowMs }: TodayRailProps) {
  const { t } = useLang();
  const { nowMs, timeZone } = useHomeClock(serverNowMs);
  const railRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const motion = useRailMotion(railRef);
  const drag = useRailDrag({ onPress: motion.stop, onRelease: motion.fling });
  const slider = useRailSlider(railRef, { thumbRef, inputRef }, motion, (first, last, total) =>
    fillTemplate(t("home.todayScrollValue"), { from: first, to: last, n: total }),
  );
  const entering = useRailEntrance(railRef);

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
          <span className={`${cards.zoom} ${styles.zoom}`}>
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

  const tomorrowLine = !tomorrow
    ? null
    : tomorrow.count > 0
      ? fillTemplate(t("home.todayEndTomorrow"), { day: tomorrow.label, n: tomorrow.count })
      : fillTemplate(t("home.todayEndTomorrowNone"), { day: tomorrow.label });

  // The row is being moved by hand or by a fling: no snapping against it, no
  // hover lift on the cards passing under the pointer.
  const moving = drag.dragging || slider.dragging || motion.flinging;

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
        <div className={styles.frame}>
          <div
            ref={railRef}
            id={RAIL_ID}
            className={styles.rail}
            data-dragging={drag.dragging ? "true" : undefined}
            data-moving={moving ? "true" : undefined}
            data-enter={entering ? "run" : undefined}
            {...drag.handlers}
          >
            {slots.map((slot, i) => (
              <Fragment key={slot.item.key}>
                {i === nowIndex ? marker : null}
                {card(slot)}
              </Fragment>
            ))}
            {nowIndex === slots.length ? marker : null}
            <div className={styles.end}>
              <span className={styles.endTitle}>{t("home.todayEndTitle")}</span>
              {tomorrowLine ? <span className={styles.endNext}>{tomorrowLine}</span> : null}
              <Link href="/calendar" prefetch={false} className={styles.endLink}>
                {t("home.todayEndLink")}
                <ChevronIcon size={14} />
              </Link>
            </div>
          </div>
          {/* The keyboard's and assistive technology's way along the row; the
              slider after it is its picture and the pointer's. Value, max and
              spoken value are kept in step with the rail by useRailSlider. */}
          <input
            ref={inputRef}
            type="range"
            className={styles.scrub}
            aria-label={t("home.todayScroll")}
            aria-controls={RAIL_ID}
            min={0}
            step={1}
            defaultValue={0}
            disabled={!slider.overflow}
            {...slider.inputHandlers}
          />
          <div
            className={styles.slider}
            data-overflow={slider.overflow ? "true" : "false"}
            data-active={slider.active ? "true" : undefined}
            data-dragging={slider.dragging ? "true" : undefined}
            aria-hidden
            {...slider.sliderHandlers}
          >
            <span className={styles.track} />
            <span ref={thumbRef} className={styles.thumb} />
          </div>
        </div>
      )}
    </section>
  );
}
