// The schedule page's title block. Server component; the one clock-dependent
// phrase (which time zone the times are in) is the ZoneNote leaf.
//
// The page's <h1> is the SEO heading the route has always had
// (dict.calendarPage.heading), visually hidden; the visible title is the
// board's short 放送表. Same split as the homepage's brand <h1>.

import section from "@/components/home/section.module.css";
import ZoneNote from "./ZoneNote";
import styles from "./ScheduleHeader.module.css";

interface ScheduleHeaderProps {
  heading: string;
  /** "2026 秋季" */
  season: string;
  title: string;
  /** "本周 77 部更新", or null when the schedule did not load. */
  weekTotal: string | null;
}

export default function ScheduleHeader({ heading, season, title, weekTotal }: ScheduleHeaderProps) {
  return (
    <header className={styles.header}>
      <h1 className={section.srOnly}>{heading}</h1>
      <span className={styles.eyebrow}>{season}</span>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.sub}>
        {weekTotal ? `${weekTotal} · ` : null}
        <ZoneNote />
      </p>
    </header>
  );
}
