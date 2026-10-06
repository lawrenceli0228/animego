// 本季高分 — the season's twelve best by AniList score, six to a row, each
// opening an AniList-style detail popover beside it on hover or keyboard focus.
//
// A server component: the popover is CSS (:hover / :focus-visible), so there
// is nothing here for the client to run except the airing time inside it.
// The popover repeats what the detail page says and is aria-hidden; the card
// link itself is the accessible object.

import type { CSSProperties } from "react";
import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import type { Dict } from "@/lib/i18n";
import { fillTemplate } from "@/lib/home/time";
import { cardToneVars } from "@/lib/home/tone";
import type { SeasonCard } from "@/lib/home/viewModels";
import AiringWhen from "./AiringWhen";
import SectionHeader from "./SectionHeader";
import { ChevronIcon, StarIcon } from "./icons";
import cards from "./cards.module.css";
import section from "./section.module.css";
import styles from "./SeasonTopGrid.module.css";

interface SeasonTopGridProps {
  items: SeasonCard[];
  dict: Dict;
  /** "2026 夏季" */
  seasonLabel: string;
  seasonHref: string;
  /** Everything the season holds, for "本季全部 N 部". */
  total: number;
}

export default function SeasonTopGrid({ items, dict, seasonLabel, seasonHref, total }: SeasonTopGridProps) {
  if (items.length === 0) return null;
  const allLabel = fillTemplate(dict.home.seasonAll, { n: total });

  return (
    <section className={section.section} aria-labelledby="home-season-top">
      <SectionHeader
        id="home-season-top"
        title={dict.home.seasonTopTitle}
        note={fillTemplate(dict.home.seasonTopSub, { season: seasonLabel })}
        link={total > 0 ? { href: seasonHref, label: allLabel } : undefined}
        phoneHides={["link"]}
      />
      <div className={styles.grid}>
        {items.map((it) => (
          <Link
            key={it.id}
            href={it.href}
            prefetch={false}
            className={`${cards.card} ${styles.item}`}
            style={cardToneVars(it.hue) as unknown as CSSProperties}
          >
            <div className={`${cards.cover} ${styles.cover}`}>
              <span className={cards.zoom}>
                <FadeImage src={it.cover} alt="" width={200} height={267} className={cards.img} />
              </span>
              <span className={cards.rule} aria-hidden />
            </div>
            <div className={styles.body}>
              <span className={`${cards.title} ${cards.clamp2} ${styles.title}`}>{it.title}</span>
              <span className={cards.meta}>
                {it.score ? <span className={cards.score}>{it.score}</span> : null}
                <span className={cards.clamp1}>{it.meta}</span>
              </span>
            </div>
            <div className={styles.pop} aria-hidden>
              <span className={styles.popStatus}>
                {it.statusLabel}
                {it.nextAiring ? <AiringWhen at={it.nextAiring.at} ep={it.nextAiring.ep} /> : null}
              </span>
              {it.score || it.bangumi ? (
                <span className={styles.popScore}>
                  <StarIcon className={styles.popStar} />
                  {it.score ? <span className={`${cards.mono} ${styles.popScoreValue}`}>{it.score}</span> : null}
                  <span>
                    {it.score ? "AniList" : ""}
                    {it.score && it.bangumi ? " · " : ""}
                    {it.bangumi ? `Bangumi ${it.bangumi}` : ""}
                  </span>
                </span>
              ) : null}
              {it.popMeta ? <span className={styles.popMeta}>{it.popMeta}</span> : null}
              {it.genres.length > 0 ? (
                <span className={styles.popTags}>
                  {it.genres.map((g) => (
                    <span key={g} className={styles.popTag}>
                      {g}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          </Link>
        ))}
      </div>
      {total > 0 ? (
        <Link href={seasonHref} prefetch={false} className={styles.allMobile}>
          {allLabel}
          <ChevronIcon />
        </Link>
      ) : null}
    </section>
  );
}
