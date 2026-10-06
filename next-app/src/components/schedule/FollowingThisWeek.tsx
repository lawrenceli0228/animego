"use client";

// 我追的 · 本周 — for a signed-in reader, every show they follow that airs in
// the window, once, at its first airing, with one word for where they stand:
// 未看 / 已看 once it has aired, 落后 N 集 / 待更新 before.
//
// `progress` came from the watching list the page fetched on the server with
// the reader's cookie; nothing here fetches. The states and the "今天 21:00"
// labels move with the same clock as the rows beside them.

import type { CSSProperties } from "react";
import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { ChevronIcon } from "@/components/home/icons";
import type { HomeClock } from "@/components/home/useHomeClock";
import { fillTemplate } from "@/lib/home/time";
import { cardToneVars } from "@/lib/home/tone";
import { followingThisWeek, whenLabel, type FollowEntry } from "@/lib/schedule/following";
import type { ScheduleDayView, ScheduleItemView } from "@/lib/schedule/viewModels";
import { useLang } from "@/lib/lang-client";
import aside from "./aside.module.css";
import styles from "./FollowingThisWeek.module.css";

/** Past this many rows the box links to the full list instead of growing. */
const MAX_ROWS = 8;

interface FollowingThisWeekProps {
  days: ScheduleDayView[];
  progress: Readonly<Record<number, number>>;
  clock: HomeClock;
}

export default function FollowingThisWeek({ days, progress, clock }: FollowingThisWeekProps) {
  const { t, lang } = useLang();
  const entries = followingThisWeek(days, progress, clock.nowMs);

  const stateText = (e: FollowEntry<ScheduleItemView>) => {
    switch (e.state) {
      case "unwatched":
        return t("schedule.unwatched");
      case "watched":
        return t("schedule.watched");
      case "behind":
        return fillTemplate(t("schedule.behind"), { n: e.behind });
      case "upcoming":
        return t("schedule.upcoming");
    }
  };

  return (
    <section className={`${aside.box} ${styles.mine}`} aria-labelledby="schedule-mine">
      <h3 id="schedule-mine" className={`${aside.title} ${styles.heading}`}>
        {t("schedule.mineTitle")}
      </h3>
      {entries.length === 0 ? (
        <p className={styles.empty}>{t("schedule.mineEmpty")}</p>
      ) : (
        <ol className={styles.list}>
          {entries.slice(0, MAX_ROWS).map((e) => {
            const it = e.item;
            const when = whenLabel(it.at, clock.nowMs, clock.timeZone, lang, t("home.today"));
            return (
              <li key={it.key}>
                <Link
                  href={it.href}
                  prefetch={false}
                  className={styles.row}
                  style={cardToneVars(it.hue) as unknown as CSSProperties}
                >
                  <span className={styles.cover}>
                    <FadeImage src={it.cover} alt="" width={34} height={48} className={styles.img} />
                  </span>
                  <span className={styles.text}>
                    <span className={styles.title}>{it.title}</span>
                    <span className={styles.when}>
                      {when} · {fillTemplate(t("home.todayEp"), { ep: it.ep })}
                    </span>
                  </span>
                  <span className={styles.state}>{stateText(e)}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
      {entries.length > MAX_ROWS ? (
        <Link href="/profile" prefetch={false} className={styles.all}>
          {t("home.continueAll")}
          <ChevronIcon />
        </Link>
      ) : null}
    </section>
  );
}
