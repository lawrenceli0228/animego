"use client";

// 评分前 10: the genre's highest-rated shows, ranked, beside the rails on a
// desktop and after them on a phone, with "完整排行" to the full ranking.
//
// Each row is its show's colour (the number, and the title under the
// pointer); the title is the row's one accessible link and carries the rank
// in words ("第 1 名") for a screen reader, which the drawn number is hidden
// from; the small cover repeats the link for the pointer and is hidden too.
// role="list": a list styled without markers loses its list semantics in
// Safari.

import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { scoreBand } from "@/components/anime/scoreStyle";
import { FaceIcon } from "@/components/seasonal/browse/icons";
import type { FilterGenre } from "@/lib/contentLabels";
import { rankSubLine, type GenreCardCopy } from "@/lib/genre/display";
import type { GenreItem } from "@/lib/genre/items";
import { gridHref } from "@/lib/genre/views";
import { fillTemplate } from "@/lib/home/time";
import { toneLadder } from "@/lib/home/tone";
import type { Lang } from "@/lib/i18n/lang";
import { scoreText } from "@/lib/seasonal/display";
import { Section, SectionHead } from "./parts";
import type { GenreCopy } from "./useGenreCopy";
import hub from "./hub.module.css";

/** The section's entrance, and each row's after it. */
const SECTION_DELAY_MS = 120;
const ROW_BASE_MS = 160;
const ROW_STEP_MS = 40;

interface TopTenProps {
  genre: FilterGenre;
  items: readonly GenreItem[];
  lang: Lang;
  copy: GenreCopy;
  card: GenreCardCopy;
  onSeeAll: () => void;
}

export default function TopTen({ genre, items, lang, copy, card, onSeeAll }: TopTenProps) {
  return (
    <Section delayMs={SECTION_DELAY_MS} labelledBy="genre-top-title" hook="top">
      <SectionHead
        id="genre-top-title"
        title={copy.topTitle}
        all={{ href: gridHref(genre, { kind: "list", list: "top" }), label: copy.topAll, onNavigate: onSeeAll, hook: "top" }}
      />
      <ol className={hub.ranks} role="list" data-ranks>
        {items.map((item, i) => {
          const tone = toneLadder(item.hue);
          const href = `/anime/${item.id}`;
          const score = scoreText(item.score);
          return (
            <li
              key={item.id}
              className={hub.rk}
              style={{ color: tone.text, animationDelay: `${ROW_BASE_MS + i * ROW_STEP_MS}ms` }}
              data-rank={i + 1}
              data-id={item.id}
            >
              <span className={hub.rkN} aria-hidden="true">
                {i + 1}
              </span>
              <Link
                href={href}
                prefetch={false}
                className={hub.rkCover}
                style={{ background: tone.fill }}
                tabIndex={-1}
                aria-hidden="true"
              >
                <FadeImage src={item.cover} alt="" width={46} height={64} className={hub.rkImg} />
              </Link>
              <div className={hub.rkMain}>
                <Link href={href} prefetch={false} className={hub.rkT}>
                  <span className={hub.srOnly}>{`${fillTemplate(copy.rank, { n: i + 1 })} `}</span>
                  {item.title}
                </Link>
                <span className={hub.rkS}>{rankSubLine(item, card, lang)}</span>
              </div>
              {score && item.score ? (
                <span className={hub.score} data-band={scoreBand(item.score)}>
                  <FaceIcon className={hub.face} />
                  {score}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
