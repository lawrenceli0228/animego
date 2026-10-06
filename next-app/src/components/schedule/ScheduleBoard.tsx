"use client";

// The schedule page (/calendar), B 逐番色.
//
// A client component for two pieces of state only: which day is selected, and
// the clock. Everything else arrives from the server — the seven days are built
// in page.tsx (lib/schedule/viewModels.ts), the reader's progress comes from
// the watching list the page fetched with their cookie, and the header, the
// sign-in prompt and the next-season link are server-rendered nodes passed in.
// Nothing here fetches.
//
// The page wears the selected day's colour: its best-rated coloured show's hue,
// turned into finished oklch() strings (lib/home/tone.ts) and written onto <main>,
// the element whose descendants read them. Switching day re-colours the
// ground, the tabs, the bars and the 现在 rule together over 0.9s.

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import scope from "@/components/home/HomeHueScope.module.css";
import { useHomeClock } from "@/components/home/useHomeClock";
import { pageToneVars } from "@/lib/home/tone";
import { revealScrollLeft } from "@/lib/schedule/reveal";
import type { ScheduleDayView } from "@/lib/schedule/viewModels";
import { useLang } from "@/lib/lang-client";
import DayPanel from "./DayPanel";
import DayTabs from "./DayTabs";
import FollowingThisWeek from "./FollowingThisWeek";
import WeekChart from "./WeekChart";
import styles from "./ScheduleBoard.module.css";

/** Breathing room left beside a pill the row scrolls to reveal. */
const REVEAL_PAD_PX = 20;

interface ScheduleBoardProps {
  /** Seven days, today first; empty when the schedule did not load. */
  days: ScheduleDayView[];
  serverNowMs: number;
  /** anilistId → watched-up-to episode; null for a visitor. */
  progress: Readonly<Record<number, number>> | null;
  header: ReactNode;
  /** Shown to visitors where a signed-in reader sees 我追的 · 本周. */
  signIn: ReactNode;
  nextSeason: ReactNode;
}

export default function ScheduleBoard({ days, serverNowMs, progress, header, signIn, nextSeason }: ScheduleBoardProps) {
  const { t } = useLang();
  const clock = useHomeClock(serverNowMs);
  const [selected, setSelected] = useState(0);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /**
   * Select a day from a tab, a bar or the arrow keys.
   *
   * On the phone's pill row the new pill may sit half off-screen; the ROW is
   * scrolled to show it, never the page (scrollIntoView would move both).
   * Keyboard selection also moves focus, without letting focus() scroll.
   */
  function select(index: number, viaKeyboard = false) {
    setSelected(index);
    const row = rowRef.current;
    const tab = tabRefs.current[index];
    if (!row || !tab) return;
    if (viaKeyboard) tab.focus({ preventScroll: true });
    const left = revealScrollLeft(
      {
        viewLeft: row.scrollLeft,
        viewWidth: row.clientWidth,
        contentWidth: row.scrollWidth,
        itemStart: tab.offsetLeft,
        itemWidth: tab.offsetWidth,
      },
      REVEAL_PAD_PX,
    );
    // The row's own scroll-behavior decides smooth or instant (instant under
    // prefers-reduced-motion — DayTabs.module.css).
    if (left !== null) row.scrollTo({ left });
  }

  const hue = days[selected]?.hue ?? null;

  return (
    <main className={`${scope.scope} ${styles.page}`} style={pageToneVars(hue) as unknown as CSSProperties}>
      {header}
      {days.length > 0 ? (
        <DayTabs days={days} selected={selected} onSelect={select} rowRef={rowRef} tabRefs={tabRefs} />
      ) : null}
      <div className={styles.content}>
        <div className={styles.panels}>
          {days.length === 0 ? <p className={styles.failed}>{t("schedule.loadFailed")}</p> : null}
          {days.map((d, i) => (
            <DayPanel key={d.key} day={d} index={i} active={i === selected} clock={clock} progress={progress} />
          ))}
        </div>
        <aside className={styles.aside}>
          {days.length > 0 ? <WeekChart days={days} selected={selected} onSelect={(i) => select(i)} /> : null}
          {progress ? <FollowingThisWeek days={days} progress={progress} clock={clock} /> : signIn}
          {nextSeason}
        </aside>
      </div>
    </main>
  );
}
