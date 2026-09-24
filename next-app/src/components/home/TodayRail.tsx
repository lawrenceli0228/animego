"use client";

// 今日更新 — today's episodes as one sideways rail, split by a "now" marker:
// aired on the left with a 已播 badge, upcoming on the right, the ones due in
// the next hour counting down with a ping.
//
// A client component only for the clock. Membership (which episodes are
// "today") is decided on the server from the schedule's own day group; what
// changes as the page stays open is only which side of "now" each one is on,
// and that comes from useHomeClock — the server's render time through
// hydration, the browser's minute after. So the first paint is already right
// and hydration cannot mismatch.
//
// On a phone the aired half collapses behind one "已播 N 部" tile, so the rail
// opens on what is still to come.

import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { fillTemplate, hhmm } from "@/lib/home/time";
import { isNextDay, slotToday, type Slot } from "@/lib/home/todaySlots";
import { cardToneVars } from "@/lib/home/tone";
import type { TodayCard } from "@/lib/home/viewModels";
import { useLang } from "@/lib/lang-client";
import SectionHeader from "./SectionHeader";
import { CheckIcon } from "./icons";
import { useHomeClock } from "./useHomeClock";
import cards from "./cards.module.css";
import section from "./section.module.css";
import styles from "./TodayRail.module.css";

interface TodayRailProps {
  items: TodayCard[];
  /** The schedule's day key (`YYYY-MM-DD`) — the day these items belong to. */
  dayKey: string;
  /** That day, already formatted on the server ("周四 9月24日"). */
  dayLabel: string;
  serverNowMs: number;
}

export default function TodayRail({ items, dayKey, dayLabel, serverNowMs }: TodayRailProps) {
  const { t } = useLang();
  const { nowMs, timeZone } = useHomeClock(serverNowMs);
  const [showAired, setShowAired] = useState(false);
  const railRef = useRef<HTMLDivElement | null>(null);

  const { slots, nowIndex } = slotToday(items, nowMs);
  const aired = slots.filter((s) => s.state === "aired");
  const now = hhmm(nowMs, timeZone);

  // Open the rail near "now" when most of it has already aired: a reader at
  // 23:00 should not have to scroll past fifteen finished episodes to find the
  // next one. Scrolls the rail itself — never scrollIntoView, which would move
  // the page too (the old carousel's rail did exactly that).
  useEffect(() => {
    const rail = railRef.current;
    const marker = rail?.querySelector<HTMLElement>("[data-now]");
    if (!rail || !marker) return;
    if (marker.offsetLeft < rail.clientWidth * 0.6) return;
    rail.scrollLeft = Math.max(0, marker.offsetLeft - 180);
    // Only on arrival; after that the reader owns the scroll position.
  }, []);

  const card = (slot: Slot<TodayCard>) => {
    const it = slot.item;
    const tone = cardToneVars(it.hue) as unknown as CSSProperties;
    const time = `${isNextDay(it.at, dayKey, timeZone) ? `${t("home.todayNextDay")} ` : ""}${hhmm(it.at, timeZone)}`;
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
            {time} · {fillTemplate(t("home.todayEp"), { ep: it.ep })}
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

  const first = aired[0]?.item;
  const last = aired[aired.length - 1]?.item;

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
        <div ref={railRef} className={styles.rail} data-aired={showAired ? "shown" : "collapsed"}>
          {aired.length > 0 ? (
            <button
              type="button"
              className={styles.airedTile}
              aria-expanded={showAired}
              onClick={() => setShowAired((v) => !v)}
            >
              <span className={styles.thumbs} aria-hidden>
                {aired.slice(0, 3).map((s) =>
                  s.item.cover ? (
                    <FadeImage key={s.item.key} src={s.item.cover} alt="" width={40} height={56} className={styles.thumb} />
                  ) : null,
                )}
              </span>
              <span className={styles.airedCount}>{fillTemplate(t("home.todayAiredCount"), { n: aired.length })}</span>
              {first && last ? (
                <span className={styles.airedRange}>
                  {hhmm(first.at, timeZone)} – {hhmm(last.at, timeZone)}
                </span>
              ) : null}
              <span className={styles.airedToggle}>{showAired ? t("home.todayHideAired") : t("home.todayShowAired")}</span>
            </button>
          ) : null}
          {slots.map((slot, i) => (
            <Fragment key={slot.item.key}>
              {i === nowIndex ? marker : null}
              {card(slot)}
            </Fragment>
          ))}
          {nowIndex === slots.length ? marker : null}
        </div>
      )}
    </section>
  );
}
