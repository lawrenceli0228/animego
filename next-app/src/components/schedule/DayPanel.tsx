"use client";

// One day of the schedule, grouped by airing time.
//
// Membership and order come from the server (buildWeek); everything that
// moves with the clock comes from `clock` — the server's render time in
// Shanghai through hydration, the browser's minute in the browser's zone
// after (useHomeClock). That covers which shows have aired, the "N 分钟后"
// countdowns, where the 现在 rule sits, the "次日" prefix and every printed
// time, so the first paint is already right and hydration cannot mismatch.
//
// All seven panels are rendered; the inactive ones are `hidden`, which keeps
// the whole week's links in the HTML and makes switching day free.

import { Fragment, type CSSProperties } from "react";
import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { StarIcon } from "@/components/home/icons";
import type { HomeClock } from "@/components/home/useHomeClock";
import { fillTemplate, hhmm } from "@/lib/home/time";
import { isNextDay, type Slot } from "@/lib/home/todaySlots";
import { cardToneVars } from "@/lib/home/tone";
import { rowFollowState } from "@/lib/schedule/following";
import { dayTimeline } from "@/lib/schedule/timeline";
import type { ScheduleDayView, ScheduleItemView } from "@/lib/schedule/viewModels";
import { useLang } from "@/lib/lang-client";
import { panelId, tabId } from "./ids";
import styles from "./DayPanel.module.css";

interface DayPanelProps {
  day: ScheduleDayView;
  index: number;
  active: boolean;
  clock: HomeClock;
  /** anilistId → watched-up-to episode; null for a visitor. */
  progress: Readonly<Record<number, number>> | null;
}

export default function DayPanel({ day, index, active, clock, progress }: DayPanelProps) {
  const { t } = useLang();
  const { groups, nowIndex } = dayTimeline(day.items, clock.nowMs);

  const statusText = (slot: Slot<ScheduleItemView>) =>
    slot.state === "aired"
      ? t("home.todayAired")
      : slot.state === "soon"
        ? fillTemplate(t("home.todayInMinutes"), { n: slot.minutesUntil ?? 1 })
        : t("schedule.later");

  const row = (slot: Slot<ScheduleItemView>) => {
    const it = slot.item;
    const mine = rowFollowState(it.ep, progress?.[it.id], slot.state === "aired");
    return (
      <li key={it.key}>
        <Link
          href={it.href}
          prefetch={false}
          className={styles.row}
          style={cardToneVars(it.hue) as unknown as CSSProperties}
          data-state={slot.state}
        >
          <span className={styles.cover}>
            <span className={styles.zoom}>
              <FadeImage src={it.cover} alt="" width={44} height={62} className={styles.img} />
            </span>
          </span>
          <span className={styles.text}>
            <span className={styles.title}>{it.title}</span>
            <span className={styles.meta}>{it.meta}</span>
          </span>
          <span className={styles.state}>
            {mine ? (
              <span className={styles.mine}>
                <span className={styles.mineDot} aria-hidden />
                {mine === "unwatched" ? t("schedule.unwatched") : t("schedule.following")}
              </span>
            ) : null}
            <span className={styles.status}>
              <span className={styles.dot} aria-hidden />
              {statusText(slot)}
            </span>
          </span>
          {it.score ? (
            <span className={styles.score}>
              <StarIcon size={12} />
              <span className={styles.scoreNum}>{it.score}</span>
            </span>
          ) : null}
        </Link>
      </li>
    );
  };

  // Decorative for assistive tech: every row already says 已播 / N 分钟后 /
  // 待播出, which is the same information in reading order.
  const nowRule = (
    <li key="now" className={styles.now} aria-hidden>
      <span className={styles.nowDot} />
      <span className={styles.nowLabel}>{fillTemplate(t("home.todayNowAt"), { time: hhmm(clock.nowMs, clock.timeZone) })}</span>
      <span className={styles.nowLine} />
    </li>
  );

  return (
    <div
      role="tabpanel"
      id={panelId(index)}
      aria-labelledby={tabId(index)}
      hidden={!active}
      className={styles.panel}
    >
      {day.items.length === 0 ? (
        <p className={styles.empty}>{t("schedule.emptyDay")}</p>
      ) : (
        <ol className={styles.groups}>
          {groups.map((g, gi) => {
            const upNext = day.isToday && gi === nowIndex;
            return (
              <Fragment key={g.at}>
                {upNext ? nowRule : null}
                <li className={styles.slot} data-aired={g.aired} data-next={upNext}>
                  <div className={styles.when}>
                    <span className={styles.time}>
                      {isNextDay(g.at, day.key, clock.timeZone) ? (
                        <span className={styles.nextDay}>{t("home.todayNextDay")}</span>
                      ) : null}
                      {hhmm(g.at, clock.timeZone)}
                    </span>
                    {g.aired ? (
                      <span className={styles.note}>{t("home.todayAired")}</span>
                    ) : upNext ? (
                      <span className={styles.note}>{t("schedule.upNext")}</span>
                    ) : null}
                  </div>
                  <ul className={styles.rows}>{g.slots.map(row)}</ul>
                </li>
              </Fragment>
            );
          })}
          {day.isToday && nowIndex === groups.length ? nowRule : null}
        </ol>
      )}
    </div>
  );
}
