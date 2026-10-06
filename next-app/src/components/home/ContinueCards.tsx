// The 继续看 cards, shared by the homepage's 继续看 section and the 全部在追
// page (/watching), so the two cannot drift apart.
//
// Server components: no hooks, no "use client". Each card is ONE link to the
// detail page, which is where playback starts — the "button" inside is its
// label, not a second control. Each card wears its own anime's colour: the
// tone strings are built in TS (lib/home/tone.ts) and written onto the card
// element itself, the element whose descendants read them. Progress reads
// `current/total` (e.g. "3/24 集"), the format the library-sync e2e spec
// asserts on.
//
//   ContinueFeatureCard — banner, status, progress, "继续看第 N 集", the bar.
//   ContinueCompactCard — cover and progress; the homepage's two smaller cards.

import type { CSSProperties } from "react";
import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { formatRelativeTime } from "@/lib/formatters";
import type { Dict, Lang } from "@/lib/i18n";
import { fillTemplate } from "@/lib/home/time";
import { cardToneVars } from "@/lib/home/tone";
import type { ContinueCard } from "@/lib/home/viewModels";
import { PlayIcon } from "./icons";
import cards from "./cards.module.css";
import styles from "./ContinueWatching.module.css";

export interface ContinueCardProps {
  c: ContinueCard;
  dict: Dict;
  lang: Lang;
  /** The request's render time, for "上次观看 3 天前". */
  nowMs: number;
}

function progressText(c: ContinueCard, dict: Dict): string {
  const unit = dict.detail.epUnit;
  return c.total ? `${c.current}/${c.total} ${unit}` : `${c.current} ${unit}`;
}

function progressLabel(c: ContinueCard, dict: Dict): string {
  return c.current > 0 ? fillTemplate(dict.home.continueProgress, { ep: c.current }) : dict.home.continueNotStarted;
}

function Bar({ c }: { c: ContinueCard }) {
  if (!c.total) return null;
  const pct = Math.min(100, (c.current / c.total) * 100);
  return (
    <span className={styles.track} aria-hidden>
      <span className={styles.fill} style={{ width: `${pct}%` }} />
    </span>
  );
}

function lastWatched(c: ContinueCard, dict: Dict, lang: Lang, nowMs: number): string | null {
  if (!c.lastWatchedAt) return null;
  const when = formatRelativeTime(c.lastWatchedAt, lang, nowMs);
  return when ? fillTemplate(dict.home.lastWatched, { when }) : null;
}

export function ContinueFeatureCard({
  c,
  dict,
  lang,
  nowMs,
  priority = false,
}: ContinueCardProps & {
  /** Above the fold where it is the page's main content (the 全部在追 page). */
  priority?: boolean;
}) {
  const cta = c.current > 0 ? fillTemplate(dict.home.continueNext, { ep: c.nextEpisode }) : dict.home.continueStart;
  const seen = lastWatched(c, dict, lang, nowMs);
  return (
    <Link
      href={c.href}
      prefetch={false}
      className={`${cards.card} ${styles.feature}`}
      style={cardToneVars(c.hue) as unknown as CSSProperties}
    >
      <span className={styles.featureArt} aria-hidden>
        <FadeImage
          src={c.banner}
          alt=""
          width={1080}
          height={228}
          className={styles.featureImg}
          priority={priority}
        />
      </span>
      <span className={styles.featureShade} aria-hidden />
      <span className={styles.featureBody}>
        <span className={styles.kicker}>
          {c.statusLabel ? (
            <>
              <span className={styles.dot} data-live={c.live} aria-hidden />
              {c.statusLabel}
            </>
          ) : null}
          {c.statusLabel && seen ? " · " : ""}
          {seen}
        </span>
        <span className={`${cards.clamp1} ${styles.featureTitle}`}>{c.title}</span>
        <span className={styles.featureEp}>
          <span className={styles.featureEpStrong}>{progressLabel(c, dict)}</span>
          {c.seasonLine ? <span>{c.seasonLine}</span> : null}
        </span>
        <span className={styles.featureFoot}>
          <span className={styles.featureCta}>
            <PlayIcon />
            {cta}
          </span>
          <span className={styles.featureProgress}>
            <Bar c={c} />
            <span className={`${cards.mono} ${styles.progressText}`}>{progressText(c, dict)}</span>
          </span>
        </span>
      </span>
      <span className={cards.rule} aria-hidden />
    </Link>
  );
}

export function ContinueCompactCard({ c, dict, lang, nowMs }: ContinueCardProps) {
  const seen = lastWatched(c, dict, lang, nowMs);
  return (
    <Link
      href={c.href}
      prefetch={false}
      className={`${cards.card} ${styles.compact}`}
      style={cardToneVars(c.hue) as unknown as CSSProperties}
    >
      <span className={`${cards.cover} ${styles.compactCover}`}>
        <span className={cards.zoom}>
          <FadeImage src={c.cover} alt="" width={96} height={136} className={cards.img} />
        </span>
        <span className={cards.rule} aria-hidden />
      </span>
      <span className={styles.compactBody}>
        {c.statusLabel ? (
          <span className={styles.chip}>
            <span className={styles.dot} data-live={c.live} aria-hidden />
            {c.statusLabel}
          </span>
        ) : null}
        <span className={`${cards.title} ${cards.clamp2} ${styles.compactTitle}`}>{c.title}</span>
        {seen || c.seasonLine ? <span className={styles.compactLine}>{seen ?? c.seasonLine}</span> : null}
        <span className={styles.compactFoot}>
          <span className={styles.compactFootRow}>
            <span>{progressLabel(c, dict)}</span>
            <span className={cards.mono}>{progressText(c, dict)}</span>
          </span>
          <Bar c={c} />
        </span>
      </span>
      <span className={`${cards.rule} ${styles.compactRule}`} aria-hidden />
    </Link>
  );
}
